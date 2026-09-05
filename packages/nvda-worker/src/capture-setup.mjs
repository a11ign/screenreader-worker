// @ts-check
/**
 * capture-setup.mjs — bring the browser and NVDA up, keep them healthy, read the page, tear them down.
 *
 * Split out of `capture-core.mjs`, which held this alongside the structural-navigation/probe machinery
 * that reads a live page once both are up. Neither direction called the other except through the two
 * seams `capture-core.mjs` and `capture-probes.mjs` still use: `captureWithNvda`/`runCapturePhases`
 * sequence phases from both files, and `capture-probes.mjs` calls back into a handful of primitives here
 * (`withTimeout`, `anchorToTop`, `waitForSpeechQuiet`, `refreshBrowseBuffer`, `reportedTitle`,
 * `waitForPageToSettle`, `readWithRetry`, `ensureSpeechChannel`) that the browser/NVDA lifecycle needs
 * too. Keeping those here — rather than in `capture-core.mjs` or duplicated — is what keeps the import
 * graph a DAG: `capture-probes.mjs` depends on this file, this file depends on neither of the other two.
 */
import { nvda, windowsActivate, windowsQuit } from "@guidepup/guidepup";
import { focusExistingBrowserWindow } from "./window-focus.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { captureFault, FAULT } from "./capture-faults.mjs";
import { errorText } from "./error-text.mjs";
import { browserArgs, browserFor } from "./browsers.mjs";
import { installSpeechChannelShim } from "./speech-channel.mjs";
import {
  censusShape,
  lastMark,
  phraseAction,
  readThroughDeadline,
  isBrowserErrorTitle,
  landedVerdict,
  pageServedRefusal,
  LANDED_BUDGET_MS,
} from "./capture-pure.mjs";
import {
  browserAlive, currentPageUrl, launchReusable, navigateExisting, navigationOutcome, reusableArgs,
  structuralCensus, bringPageToFront, setExpectedPageUrl,
} from "./browser-session.mjs";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @typedef {import("./capture-pure.mjs").CaptureDiagnostics} Diag
 *   The mark log, threaded through almost every function here. Aliased rather than re-described: this
 *   file passes it to forty of them, and forty inline shapes is forty chances to disagree.
 *
 * @typedef {{ id: string, name: string, image: string, windowTitle: string, profileName: string,
 *             suppressedFeatures: string[], extraArgs: string[], exes: () => string[] }} BrowserPreset
 *   One entry from `browsers.mjs`, READ off that file rather than guessed -- the first version of this
 *   typedef invented `processImage`, `args` and `profileDir`, none of which exist, and omitted `image`,
 *   which two functions here call. `browsers.mjs` exists because the browser was spread across EIGHT
 *   sites and a change applied at seven of them launches Chrome and kills Edge; a shared type is the same
 *   argument, and a shared type describing the wrong fields is that defect wearing the remedy's clothes.
 */


/**
 * Installed at module load, before anything calls `nvda.start()`, so the very first connection to NVDA
 * Remote is tracked. Idempotent, so importing this module twice is harmless.
 */
const speechChannel = installSpeechChannelShim();

// A diagnostics recorder: every phase appends a timestamped entry rather than swallowing errors, so an
// empty capture can be explained after the fact.
//
// Duplicated from `capture-core.mjs` rather than imported: it is a pure, dependency-free 5-line function,
// and importing it back would put an edge from this file to that one where none otherwise exists --
// `warmUpScreenReader` and `shutdownScreenReader` need their own diagnostics sink and nothing else there.
/** @param {{ event: string, [key: string]: any }[]} [sink] @returns {Diag} */
function createDiagnostics(sink) {
  const entries = sink ?? [];
  const startedAt = Date.now();
  const mark = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ info = {}) => entries.push({ event, atMs: Date.now() - startedAt, ...info });
  return { entries, mark };
}

const NVDA_SPEECH_BUDGET_MS = 10_000; // how long a fresh NVDA gets to SPEAK before silence is a fault

// After destroying the speech socket, how long guidepup needs to reconnect and re-join the channel.
// Its handler runs synchronously on the socket 'error' event and the connection is to localhost, so
// this is a settle rather than a wait -- against ~23s for the NVDA restart it replaces.
// How long to keep asking whether the rebuilt channel speaks before giving up and restarting NVDA.
// Generous on purpose: restarting NVDA is the harmful remedy, so the bar for reaching it must be high.
const SPEECH_RECONNECT_BUDGET_MS = 6_000;

const WINDOW_POLL_MS = 400; // between attempts to activate the Edge window

const READY_ATTEMPTS = 3; // re-activate + re-anchor tries before reading anyway

const EDGE_EXIT_TIMEOUT_MS = 8_000; // wait for Edge to actually exit during cleanup

// Recycle NVDA after this many captures even when reuse is on. Reuse saves ~10s per
// capture, but a screen reader held open indefinitely is exactly the long-running-state
// risk the correctness audit warns about, so bound it rather than trusting it forever.
const MAX_CAPTURES_PER_NVDA = 25;

// NVDA's Remote Access channel, which is how guidepup talks to it. Hardcoded in guidepup too
// (lib/windows/NVDA/constants.js), so there is nothing to configure on either side.
const NVDA_REMOTE_PORT = 6837;

const REUSE_PROBE_MS = 2_000;

const NVDA_EXIT_TIMEOUT_MS = 15_000; // for an old NVDA to release port 6837

export const STATE_POLL_MS = 100;

// Above the slowest honest navigation, not above a fixture's. A real site is the slow case, and being
// wrong here turns "still loading" into "wrong page" — which destroys a capture rather than costing time.

const ADVANCE_TIMEOUT_MS = 8_000; // moving to the next line/object

const READ_TIMEOUT_MS = 5_000; // reading the phrase after advancing

export const NAV_TIMEOUT_MS = 6_000; // a quick-nav jump (next heading/landmark/field)

export const QUERY_TIMEOUT_MS = 4_000; // reading lastSpokenPhrase / spokenPhraseLog

/**
 * Bounds for the guidepup calls that had none.
 *
 * Every one of these reaches outside this process — `nvda.*` over a TLS socket to NVDA Remote, `windowsQuit`
 * through `cscript` and a WMI process scan — and an unbounded await on the outside world is how a capture ran
 * 342 s past a 280 s budget. Audited as a set rather than one at a time, because fixing them singly is what
 * made this take a night: each fix moved the hang to the next unbounded call and looked like a new bug.
 *
 * Generous rather than tight. A cold NVDA start is ~19 s measured, so 60 s is "something is wrong", not
 * "the guest is busy" — the deadline must exceed the slowest honest answer or a bound turns a slow success
 * into a false failure.
 */
const NVDA_START_TIMEOUT_MS = 60_000;

/**
 * NVDA's OWN signals for "the virtual buffer is still building" and "it finished".
 *
 * Read out of NVDA's source rather than inferred from behaviour (`source/virtualBuffers/__init__.py`):
 *
 *   def _loadProgress(self):
 *     # Translators: Reported while loading a document.
 *     ui.message(_("Loading document..."))
 *
 *   def _get_isReady(self):
 *     return bool(self.VBufHandle and not self.isLoading)
 *
 * and in `_loadBufferDone`, `ui.message(_("Refreshed"))` followed by `event_treeInterceptor_gainFocus()`.
 *
 * Two facts that change what a capture should do. The buffer is filled by a **daemon thread with no timeout**,
 * so on a large DOM `isLoading` simply stays true for as long as it takes — and NVDA says so out loud after one
 * second. A blank title during that window is not a broken page, it is "we asked too early", and this project's
 * own first rule is that those must never be the same observation. Reactivating Edge in that window, which is
 * what the code did, cannot help: the browser is fine and NVDA is busy.
 *
 * **These strings are translated.** The guests run English NVDA, so matching them is sound here and stated as a
 * limitation rather than pretended away; a non-English guest falls back to the budget, which is why the budget
 * still exists.
 */
const NVDA_LOADING_RE = /loading document/i;

const NVDA_REFRESHED_RE = /\brefreshed\b/i;

/**
 * How long a document may take to become readable before we call it a failure.
 *
 * Far longer than the old 6 s title timeout, because that number was measuring the wrong thing: it bounded how
 * long NVDA had to ANSWER, on a page where NVDA had not finished reading the document into its buffer. A real
 * marketing page exceeded it while working correctly.
 */
const BUFFER_READY_BUDGET_MS = 90_000;

const BUFFER_POLL_MS = 500;

const NVDA_STOP_TIMEOUT_MS = 20_000;

const BROWSER_QUIT_TIMEOUT_MS = 20_000;

// `errorText` lives in `error-text.mjs` now, reachable by subpath so portable modules can use it without
// pulling this file — and therefore guidepup — in with it. This was a private one-liner with 35 call
// sites that nothing else could reach, so every other module narrowed a caught value by hand or not at all.
export const errMsg = errorText;

// Reject if `promise` has not settled within `ms`, naming the step so a timeout
// is self-describing in the diagnostics.
export const withTimeout = (/** @type {Promise<any>} */ promise, /** @type {number} */ ms, /** @type {string} */ label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

// --- Setup phases ---------------------------------------------------------

/**
 * Where the configured browser lives on this guest, or null if it is not installed.
 *
 * Resolved so we can spawn it directly and OWN the process: launching via `cmd /c start` returns no
 * handle, which means teardown can only be guessed at. See `closeBrowser`.
 */
/** @param {BrowserPreset} app */
function resolveExe(app) {
  return app.exes().find((/** @type {string} */ path) => existsSync(path)) ?? null;
}

/**
 * Keep the browser alive between captures and re-point it, rather than cold-starting Chromium every time.
 *
 * **On by default**, disable with `A11Y_REUSE_BROWSER=0`. It was gated behind an opt-in until
 * `evidence:check` had answered, and the answer came back better than expected.
 *
 * Throughput, three workers, same page, 7 interleaved rounds each:
 *
 *   cold start per capture   41.5 s median, 0.072 captures/s across the pool
 *   reused browser           11.6 s median, 0.259 captures/s   (windowsActivate 8.9 s -> 1.3 s)
 *
 * The pool went from scaling NEGATIVELY -- one worker beat three -- to scaling linearly, because the
 * shared resource being contended was the SSD and three guests cold-starting Chromium was what
 * saturated it.
 *
 * On evidence, the honest version: `evidence:check` reports CHANGED on a handful of form cases, and it
 * reports the SAME cases with reuse turned OFF. The difference is a pre-existing render race on
 * browser-drawn widgets (`<input type="date">` picker buttons announce as U+FFFC when NVDA reads the
 * field before Edge has painted them), present in 3-31% of affected captures across the corpus
 * depending on environment. Reuse did not introduce it; measured 0 of 14 with reuse against 1 of 6
 * without, which is consistent with a warm renderer painting before the read rather than after it.
 * Small samples, so that is a direction rather than a proof -- watch it.
 */
const REUSE_BROWSER = process.env.A11Y_REUSE_BROWSER !== "0";

/**
 * Is the browser reused for THIS capture?
 *
 * Per-request, mirroring `reuseScreenReader`, because the env variable alone made reuse impossible to
 * isolate without editing a scheduled task on the guest — and a diagnosis that costs a ceremony is one
 * nobody performs. It exists for a specific open question: a capture issued after a sequence of others
 * returned the correct document TITLE and the PREVIOUS page's content, and browser reuse is the first
 * suspect precisely because it is on by default. See PLAN.md.
 *
 * The env variable remains the fleet-wide default; the option overrides it for one capture only.
 */
export const reuseBrowserFor = (/** @type {{ reuseBrowser?: boolean }} */ opts) =>
  typeof opts?.reuseBrowser === "boolean" ? opts.reuseBrowser : REUSE_BROWSER;

/**
 * Recycle the reused browser this often.
 *
 * Reuse trades a cold start for accumulated state, and accumulated state is an evidence risk, not just
 * a memory one. Across 1,061 different pages one Edge builds up cookies, history and — the one that
 * would actually corrupt a capture — **autofill**: a form page read after two hundred other form pages
 * can be offered suggestions the first one never saw, and NVDA announces those. That is cross-page
 * contamination, it only appears deep into a run, and it looks like a real difference between cases.
 *
 * The same reasoning and the same number as MAX_CAPTURES_PER_NVDA. Bounded reuse keeps nearly all of
 * the saving — one cold start per 25 captures instead of per capture — while capping how far state can
 * drift from a fresh profile.
 */
const MAX_CAPTURES_PER_BROWSER = 25;

/** The live reusable browser, if we started one. Null when reuse is off or it has gone. */
/** @type {any} */
let reusableBrowser = null;

let browserCaptures = 0;

/**
 * WHICH browser the live process is, so teardown kills the one we started.
 *
 * Module state rather than a threaded argument because it is describing a fact about the running process,
 * not a choice the caller is making: `closeBrowser` must kill whatever `openPage` actually launched, and a
 * request that asked for Chrome while Edge is still up would otherwise pass "chrome" into a taskkill aimed
 * at an Edge process. The worker serves one capture at a time (`busy`), so there is exactly one of these.
 */
/** @type {BrowserPreset | null} */
let activeApp = null;

/**
 * The preset the running browser belongs to, falling back to the guest's configured one.
 *
 * The fallback is not decoration: `closeBrowser` and the activate fallback can both run before any capture
 * has launched anything — teardown at shutdown, a stray left by a previous worker — and `activeApp.image`
 * on a null would be a TypeError thrown from inside a `finally`, which is the shape that leaks a browser
 * process rather than reporting a fault.
 */
function runningApp() {
  return activeApp ?? browserFor();
}

/**
 * Get a window showing `url`, by the cheapest route available.
 *
 * Three cases, in cost order: navigate a browser that is already up (~0 s), start a reusable one
 * (a cold start, paid once per worker rather than once per capture), or the original one-shot launch.
 */
/**
 * Did this capture navigate an ALREADY-OPEN window, rather than launch a fresh browser?
 *
 * The distinction is the whole of the stale-buffer fault. A freshly launched Edge has no previous document,
 * so NVDA's browse-mode buffer can only be the one we asked for. A reused window has a LIVE buffer for the
 * page before it, and rebuilding that buffer is asynchronous — so there is a window in which NVDA reports
 * the new document's title (which comes from the focus object, and updates on navigation) while its buffer
 * still holds the old document's content. That is exactly what was observed: correct title, previous page's
 * text, one phrase kept over 40 advances.
 */
let navigatedExistingWindow = false;

/**
 * Close and forget the reusable browser, recording why.
 *
 * Three call sites reach this — the capture cap, a navigation that failed, and a request that asked for a
 * different browser — and each of them previously repeated the same three lines. Repeating them is how one
 * of them comes to forget `browserCaptures = 0` and recycle every capture thereafter.
 */
/** @param {Diag} diag @param {string} mark @param {Record<string, unknown>} [detail] */
async function discardReusable(diag, mark, detail) {
  diag.mark(mark, detail);
  await closeBrowser(diag, reusableBrowser);
  reusableBrowser = null;
  browserCaptures = 0;
}

// `app` defaults rather than being required: every caller passes one, and a future caller that forgets
// should get the guest's configured browser rather than a TypeError inside the capture path.
/**
 * @param {string} url @param {Diag} diag
 * @param {{ reuse?: boolean, app?: BrowserPreset }} [options]
 */
export async function openPage(url, diag, { reuse = REUSE_BROWSER, app = browserFor() } = {}) {
  navigatedExistingWindow = false;
  // The ONE chokepoint every capture navigates through, reuse or fresh launch alike -- see
  // `setExpectedPageUrl`'s own comment for why this cannot be inferred inside browser-session.mjs on the
  // fresh-launch path (the URL is a command-line flag there, never a `Page.navigate` this module observes).
  setExpectedPageUrl(url);
  if (!reuse) return launchBrowser(url, diag, app);
  // A request may name a different browser than the one still running. Reusing that window would capture
  // Edge and label the evidence Chrome — the cache key would be a lie told by the tool about itself, which
  // is worse than a slow capture. Switching costs one cold start and happens only when a run deliberately
  // compares the two.
  if (reusableBrowser && activeApp && activeApp.id !== app.id) {
    await discardReusable(diag, "browserSwitched", { from: activeApp.id, to: app.id });
  }
  if (reusableBrowser && browserCaptures >= MAX_CAPTURES_PER_BROWSER) {
    await discardReusable(diag, "browserRecycle", { after: browserCaptures });
  }
  if (reusableBrowser && await browserAlive()) {
    try {
      await navigateExisting(url);
      browserCaptures += 1;
      // NVDA's virtual buffer belongs to the window, not the navigation: re-pointing an existing window
      // over CDP does not rebuild it, so the buffer can still hold the PREVIOUS page while the document
      // title is already the new one. `refreshBrowseBuffer` needs to know it must ask NVDA to re-read,
      // and this assignment is the only thing that tells it. It was missing once, which made the whole
      // remedy dead code that no test and no type-check could see -- the mark it emits is the proof.
      navigatedExistingWindow = true;
      diag.mark("browserReused", { url, captures: browserCaptures });
      return reusableBrowser;
    } catch (error) {
      // A reusable browser that will not navigate is worse than none: fall back to a clean one-shot
      // rather than capturing whatever page happened to be showing. Reading the PREVIOUS page while
      // every check passes is the evidence-rot failure this project has already paid for once.
      await discardReusable(diag, "browserReuseFailed", { error: errMsg(error) });
    }
  }
  const exe = resolveExe(app);
  if (!exe) return launchBrowser(url, diag, app);
  try {
    reusableBrowser = await launchReusable({
      exe, args: reusableArgs(url, browserArgs(app, url)),
      // `launchReusable` declares `onEvent: (e: object) => void`, so the parameter is typed to match and
      // the shape is read inside. A narrower parameter is not a compatible handler.
      onEvent: (e) => { const event = /** @type {{ type: string }} */ (e); diag.mark(event.type, event); },
    });
    activeApp = app;
    browserCaptures = 1;
    return reusableBrowser;
  } catch (error) {
    diag.mark("browserReuseLaunchFailed", { error: errMsg(error) });
    return launchBrowser(url, diag, app);
  }
}

// Open the page in a fresh, maximized Edge window, returning the process when we own it.
//
// Owning it matters: with a dedicated --user-data-dir there is no existing instance to hand
// off to, so this process IS the browser and its "exit" is a real event we can await
// instead of polling the task list. That is what lets the next capture know the previous
// Edge has genuinely gone -- captures run back to back, and starting one while the last is
// still tearing down produced exactly the "blank, blank" transcripts we kept retrying past.
/**
 * Launch Edge the simple way, WITH the DevTools port.
 *
 * The port used to be added only by `reusableArgs`, so any capture that took this path — a failed reusable
 * launch, or reuse turned off — had no DevTools endpoint at all. Everything CDP-based then failed for a reason
 * that reads like a timeout and is really an absence: the structural census came back `null` with
 * "CDP /json/list did not answer", which is true and misleading, because nothing was listening. The census is
 * the AX tree's own count of links, graphics and controls, and it is the ONLY ground truth this capture has
 * against which to state how much of the page a sweep actually reached.
 *
 * Costs nothing to add. Chromium opens the port and ignores it if nobody connects, and this path only runs
 * when there is no reusable browser holding the port already.
 */
/** @param {string} url @param {Diag} diag @param {BrowserPreset} app */
function launchBrowser(url, diag, app) {
  const exe = resolveExe(app);
  const args = reusableArgs(url, browserArgs(app, url));
  activeApp = app;
  if (!exe) {
    // Fall back to the old indirect launch rather than failing the capture: an unusual browser
    // install should cost us the exit event, not the whole run.
    diag.mark("browserLaunched",
      { url, owned: false, reason: `${app.image} not found in the standard locations` });
    // The image name comes from an allow-list, never from the request — see `resolveBrowser`. That is
    // what makes interpolating it into a `cmd` line safe.
    spawn("cmd", ["/c", "start", "", app.image, ...args], { detached: true, stdio: "ignore" });
    return null;
  }
  const child = spawn(exe, args, { stdio: "ignore" });
  child.on("error", (e) => diag.mark("browserError", { error: errMsg(e) }));
  diag.mark("browserLaunched", { url, owned: true, pid: child.pid });
  return child;
}

// Bring Edge to the foreground. Relying on the launch to take focus was a source
// of flaky, empty captures, so we focus it explicitly.
//
// POLLS rather than sleeping a fixed 12s first. The old fixed wait was both too slow
// (Edge is usually up in well under a second, and 12s x 90 captures is 18 minutes of
// doing nothing) and too optimistic: under load Edge took longer than the guess, the
// window was activated before it existed, and the capture came back as two "blank"
// phrases with no error anywhere. Waiting for the condition is faster AND correct;
// browserWaitMs is now the upper bound rather than the wait itself.
/**
 * One attempt at guidepup's activate may not exceed this.
 *
 * The deadline below bounded the retry LOOP and not the call inside it, so a single `windowsActivate` that
 * blocked forever meant the deadline was never re-evaluated: measured on a real website, `browserReady` at
 * 13.9 s and the activation still running at 342 s, against a 280 s hard timeout for the whole capture. A
 * timeout on a loop is not a timeout on the work it does.
 */
const ACTIVATE_ATTEMPT_MS = 20_000;

/** What one reactivation attempt inside `waitForDocument` may cost. It retries, so each try stays short. */
const REACTIVATE_BUDGET_MS = 25_000;

/**
 * The cheap focus path gets longer than the default here, and the reason is measured.
 *
 * Enumerating windows costs 2.5 s on an idle guest and exceeded 8 s on one loading a heavy real page — the
 * `Add-Type` compile is the bulk of it. At 8 s it timed out and, worse, consumed nearly the whole focus budget
 * so guidepup's fallback was left 1 s: two bounded attempts that both failed because the budget was spent
 * rather than because focusing was impossible.
 */
const FAST_FOCUS_MS = 15_000;

/**
 * Activate Edge, bounded by a deadline, whichever path gets there.
 *
 * ONE function, because there were two `windowsActivate` call sites and only one of them was bounded. The
 * unbounded one — `waitForDocument`'s reactivation, reached only when NVDA cannot name the document — is
 * exactly where a real website hung for 234 seconds inside a 280-second budget. That is this repo's own
 * recurring shape: a remedy applied at one call site when the behaviour reaches several, so the remedy now
 * lives in the only place either caller can use.
 *
 * @returns {Promise<{ok: boolean, via: string, error: string, fastReason: string}>}
 */
/** @param {number} deadline */
async function activateBrowserWithinDeadline(deadline) {
  const remaining = () => deadline - Date.now();
  if (remaining() <= 0) return { ok: false, via: "none", error: "no time left to activate", fastReason: "" };

  // FIRST, because it is the only route that does not enumerate something. One CDP round trip on a socket the
  // worker already uses, against a window Chromium owns and we just navigated. The two alternatives below both
  // failed on a heavy real page for the same reason: guidepup's WMI process scan and our own `Add-Type` compile
  // are both O(how busy the guest is), and the guest is busiest exactly when the page is hardest.
  const cdp = await bringPageToFront();
  if (cdp.ok) return { ok: true, via: "cdpBringToFront", error: "", fastReason: "" };

  const fast = await focusExistingBrowserWindow({ timeoutMs: Math.min(FAST_FOCUS_MS, remaining()) });
  if (fast.found && fast.foreground) return { ok: true, via: "setForegroundWindow", error: "", fastReason: "" };
  // Found-but-refused and no-window-at-all are different faults: guidepup can launch a browser that is
  // missing, but it cannot talk Windows into handing over a foreground it has refused.
  const fastReason = [
    cdp.reason ? `cdp: ${cdp.reason}` : "",
    fast.found ? "SetForegroundWindow refused" : (fast.reason ?? "no Chromium window found"),
  ].filter(Boolean).join("; ");

  if (remaining() <= 0) return { ok: false, via: "fast", error: "deadline spent on the fast path", fastReason };
  try {
    // guidepup matches `windowTitle` as a REGEX over MainWindowTitle, and an `--app` window is titled with
    // the page title — so this rarely matches for either browser. It is kept because it can LAUNCH a
    // browser that is missing, which the fast path deliberately cannot.
    await withTimeout(
      windowsActivate(runningApp().image, runningApp().windowTitle),
      Math.min(ACTIVATE_ATTEMPT_MS, Math.max(1_000, remaining())),
      "windowsActivate",
    );
    return { ok: true, via: "guidepup", error: "", fastReason };
  } catch (e) {
    return { ok: false, via: "guidepup", error: errMsg(e), fastReason };
  }
}

/**
 * Put the browser in the foreground, cheaply, and never for longer than we are given.
 *
 * Two paths, fast one first. `focusExistingBrowserWindow` enumerates windows and calls
 * `SetForegroundWindow` — no process enumeration, so a page with fifty Edge renderers costs the same as an
 * empty one. guidepup's `windowsActivate` remains the fallback because it can LAUNCH Edge, which our path
 * deliberately cannot; see `window-focus.mjs` for why that launching is exactly what made it slow.
 */
/** @param {number} maxWaitMs @param {Diag} diag */
export async function focusBrowserWindow(maxWaitMs, diag) {
  const deadline = Date.now() + maxWaitMs;
  const startedAt = Date.now();
  let last = { ok: false, via: "none", error: "never attempted", fastReason: "" };
  while (Date.now() < deadline) {
    last = await activateBrowserWithinDeadline(deadline);
    if (last.ok) {
      // Activating a window makes NVDA announce the new foreground, so "speech has gone quiet" IS the
      // condition that the transition finished -- and it is the screen reader's own view of it, which is
      // the only view that matters for a screen-reader capture.
      await waitForSpeechQuiet("windowSettle");
      diag.mark("windowsActivate", { ok: true, via: last.via, waitedMs: Date.now() - startedAt });
      return;
    }
    await sleep(WINDOW_POLL_MS);
  }
  // Both reasons on the failure, so "we never found a window" and "Windows would not give us the foreground"
  // stay distinguishable in the evidence — they have different repairs.
  diag.mark("windowsActivate", {
    ok: false, via: last.via, error: last.error, fastReason: last.fastReason,
    waitedMs: Date.now() - startedAt,
  });
}

// Ask NVDA what document it is in, and re-focus until it names one.
//
// This is the gate that makes a capture self-verifying. `windowsActivate` succeeding only
// means an Edge process owns a window; it does not mean the page is rendered, and reading
// too early yields "blank" lines that look exactly like a page with no content. Rather
// than lengthen a guess, ask the screen reader what it can actually see.
//
// Deliberately does NOT throw when the title never arrives: not every page has a title,
// and the caller (and the dataset capture step) verify content independently. Recording
// documentReady:false makes the cause visible instead of leaving a mystery blank capture.
/**
 * Force NVDA to rebuild its browse-mode buffer for the document actually loaded.
 *
 * Only after navigating an ALREADY-OPEN window, because that is the only case where a live buffer for a
 * different page can exist. This ELIMINATES the stale-buffer state rather than detecting it, which matters
 * because detecting it is what failed: `waitForDocument` gates on NVDA's reported TITLE, and the title comes
 * from the focus object and updates the moment Edge navigates. A correct title is not evidence of a correct
 * buffer — and the gate does not even compare that title to the page requested, so any non-blank title
 * passes.
 *
 * That gate was written for the LAUNCH path, where a fresh Edge process means there is no previous buffer to
 * be stale, so the title arriving IS the document arriving. Browser reuse was added later and turned on by
 * default, introducing a state the gate structurally cannot distinguish. Same shape as the three defects
 * CLAUDE.md records: a remedy correct at one call site, never revisited when the behaviour reached another.
 *
 * `NVDA+F5` is NVDA's own "refresh browse mode document". `perform` rather than `press`, unlike the Escape
 * remedy, because this command needs the NVDA modifier and only `perform` can send it. A failure is recorded
 * rather than thrown: a refresh that did not happen must not fail a capture that may be perfectly fine.
 */
/** @param {Diag} diag */
export async function refreshBrowseBuffer(diag) {
  // Always mark, even when there is nothing to do. A silent skip and a silent success are the same
  // absence in the evidence, and that is how this remedy sat here as dead code: the mark was inside the
  // guard, so "the flag was false" was indistinguishable from "the refresh never ran at all".
  if (!navigatedExistingWindow) {
    diag.mark("browseBufferFresh", { reason: "a new window was launched, so NVDA built its buffer here" });
    return;
  }
  try {
    await withTimeout(
      nvda.perform(nvda.keyboardCommands.refreshBrowseDocument), NAV_TIMEOUT_MS, "refreshBrowseDocument");
    // Wait for NVDA to finish REBUILDING, not merely for speech to pause. `_loadBufferDone` announces
    // "Refreshed" and then reports the document, and on a large DOM that arrives long after any quiet window
    // would have expired — the old 5 s settle returned while the buffer was still filling, which is precisely
    // how a capture came to read a document NVDA had not finished loading.
    const rebuilt = await waitForBufferReady(diag);
    // The rebuild's announcement must land HERE rather than in the read-through, where `sweepStepFromSpeech`
    // would read new speech as proof of movement.
    await waitForSpeechQuiet("browseRefreshSettle");
    diag.mark("browseBufferRefreshed", {
      reason: "navigated an already-open window", ready: rebuilt.ready, refreshed: rebuilt.refreshed,
    });
  } catch (error) {
    diag.mark("browseBufferRefreshFailed", { error: errMsg(error) });
  }
}

/**
 * Is NVDA still loading the document into its virtual buffer?
 *
 * Waits for its progress message to STOP, which is the only signal available from outside: `isReady` is
 * internal to NVDA and there is no command that reports it. Returns what it observed rather than a boolean, so
 * "it was never loading" and "it loaded and we saw it finish" stay distinguishable from "we gave up waiting".
 */
/** @param {Diag} diag @param {number} [budgetMs] */
async function waitForBufferReady(diag, budgetMs = BUFFER_READY_BUDGET_MS) {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let sawLoading = false;
  while (Date.now() < deadline) {
    const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "bufferLog").catch(() => [])) || [];
    const recent = log.slice(-6).join(" | ");
    if (NVDA_LOADING_RE.test(recent)) {
      sawLoading = true;
      await sleep(BUFFER_POLL_MS);
      continue;
    }
    // "Refreshed" is `_loadBufferDone`'s completion message on a rebuild, so seeing it is positive proof the
    // buffer finished rather than an absence of evidence.
    const refreshed = NVDA_REFRESHED_RE.test(recent);
    diag.mark("bufferReady", { sawLoading, refreshed, waitedMs: Date.now() - startedAt });
    return { ready: true, sawLoading, refreshed };
  }
  // Still announcing progress when the budget ran out. Reported, never silently treated as an empty page —
  // "the document never finished loading" and "the page has nothing to say" are different findings.
  diag.mark("bufferReady", { sawLoading, refreshed: false, timedOut: true, waitedMs: Date.now() - startedAt });
  return { ready: false, sawLoading, refreshed: false };
}

/** Between two reads of the tree. A poll INTERVAL, not a guess at how long rendering takes. */
const SETTLE_POLL_MS = 400;

/** The ceiling. A page still changing after this is captured as it stands, and the mark says so. */
const SETTLE_BUDGET_MS = 6000;

/**
 * Wait until the page STOPS CHANGING, not until it looks finished.
 *
 * The URL guard proves the browser is showing the right address. It says nothing about whether that
 * document has rendered, and for a client-rendered page the address is correct immediately while the DOM
 * is still a shell. Every other wait in this file is speech-based, and speech settles just as happily on
 * a shell as on a page — measured 2026-08-26 on the Met Office warnings page, captured as `"blank"`, 27
 * announcements of navigation and a census of `heading=0`, while its published HTML carries FORTY
 * headings. That produced two WCAG findings against a page that has none of those faults.
 *
 * SETTLED, never "has content". Waiting for a heading would hang for the whole budget on a page that
 * genuinely has none — which is exactly what `1.3.1:no-headings` exists to catch — and this repo's rule
 * is that a check must never reject evidence whose absence is the finding. Two consecutive identical
 * reads of the tree mean the DOM has stopped moving, whatever it contains.
 *
 * It costs nothing where nothing was wrong: a server-rendered page is already settled, so the first two
 * reads agree and this returns after one interval.
 */
/** @param {Diag} diag */
export async function waitForPageToSettle(diag) {
  const startedAt = Date.now();
  let previous = null;
  let reads = 0;
  while (Date.now() - startedAt < SETTLE_BUDGET_MS) {
    const census = await structuralCensus();
    reads += 1;
    // A FAILED CENSUS IS NOT A READING, and it used to be treated as one. `structuralCensus` answers
    // `{ error }` when CDP does not reply -- truthy, so the guard below let it through, and reading four
    // absent fields off it produced the string `"undefined/undefined/undefined/undefined"`. Two failures
    // in a row therefore compared EQUAL and this returned "settled" having learnt nothing.
    //
    // The cost is exactly what this function exists to prevent: it is the only non-speech wait in the
    // file, added because speech settles just as happily on a shell as on a page -- the Met Office
    // warnings page captured as `"blank"` with a census of heading=0 against forty in its HTML, and two
    // WCAG findings against a page that has neither. A census that cannot answer skipping the wait puts
    // that back. Found by typechecking this file, not by a failing capture: the outcome of the bug is
    // "we stopped waiting", which looks like success.
    const shape = censusShape(census);
    if (shape !== null && shape === previous) {
      // MARKED whether or not it had to wait, so "settled immediately" and "never ran" can never be the
      // same silence — the `refreshBrowseBuffer` rule, which sat inert while green results vouched for it.
      diag.mark("pageSettled", { reads, waitedMs: Date.now() - startedAt, shape });
      return;
    }
    previous = shape;
    await sleep(SETTLE_POLL_MS);
  }
  // Still moving. Captured as it stands rather than failed: a page that never settles is a real thing
  // (a ticker, a live feed), and refusing it would reject evidence rather than describe it.
  // `settled: false` covers two different things and now says which. A page still moving is a real thing
  // (a ticker, a live feed) and is captured as it stands; a census that never answered means nobody
  // asked, and reading the second as the first is how "we could not tell" becomes "it kept changing".
  diag.mark("pageSettled", { reads, waitedMs: Date.now() - startedAt, settled: false, sawCensus: previous !== null });
}

/** @param {string} url @param {Diag} diag */
export async function assertLandedOnRequestedPage(url, diag) {
  const verdict = await landedVerdict(url, { read: currentPageUrl });
  // Marked whether or not it had to wait, so "matched immediately" and "matched after 4 s" are
  // distinguishable — and so a future reader can tell this ran at all. A remedy with no mark can be inert
  // while green results vouch for it, which is exactly what `refreshBrowseBuffer` did.
  diag.mark("landedOnRequested", { ...verdict, requested: url });
  if (verdict.ok) return;
  // Silence from CDP for the whole budget is not a claim that the page is wrong. Saying it was would be
  // the same conflation FAULT.WRONG_PAGE was split out to remove.
  if (!verdict.actual) return;
  throw captureFault(
    FAULT.WRONG_PAGE,
    `the browser is showing ${JSON.stringify(verdict.actual)}, not the page requested `
      + `(${JSON.stringify(url)}), after waiting ${LANDED_BUDGET_MS} ms for it to navigate`,
  );
}

/**
 * THE URL IS RIGHT AND THE PAGE BEHIND IT IS MISSING -- determinism-plan D6.
 *
 * `assertLandedOnRequestedPage` proves the browser is showing the address we asked for. It cannot see an
 * unserved page, because the address of an error page IS the address requested. That gap has cost this
 * project four captures-that-looked-valid, all of them a page server nobody leased.
 *
 * IT IS DELIBERATELY NOT A DISCIPLINE. The plan's own words: the guarded path is always the ceremonial
 * one, so a five-line diagnostic skips the lease -- and a diagnostic is exactly when you are moving fast
 * and least inclined to doubt the answer. Put here, every ad-hoc script gets the property for free, which
 * is the only way it survives a hurry. The evidence for that framing is that the person who had just
 * fixed it in one script reproduced it in the next two.
 *
 * THREE OUTCOMES, KEPT DISTINCT, because collapsing two of them is how this repo's faults hide:
 *   a status outside 2xx   the server answered and did not serve this page -- REFUSED
 *   status 0               there was no HTTP response at all (connection refused) -- REFUSED
 *   null                   we could not ask -- MARKED, never refused. "Unchecked" is not "clean", and it
 *                          is not "broken" either.
 *
 * @param {string} url @param {Diag} diag
 */
export async function assertPageWasServed(url, diag) {
  // Only HTTP(S) has a status to read. A `file://` capture would report 0 and be refused for having done
  // nothing wrong -- a guard that fires on correct usage is one that gets switched off.
  if (!/^https?:$/i.test(safeProtocol(url))) return;
  const { outcome, waitedMs, polls } = await settledNavigation();
  // Marked whether or not it refused, so "checked, 200" and "never ran" can never be the same silence.
  // `refreshBrowseBuffer` was inert through three green `capture:check` runs for want of exactly this.
  diag.mark("pageServed", { requested: url, waitedMs, polls,
    ...(outcome ?? { status: null, unavailable: "no navigation entry -- nothing was loaded here" }) });
  const refusal = pageServedRefusal(url, outcome);
  if (refusal) throw captureFault(FAULT.PAGE_UNREACHABLE, refusal);
}

/** Between reads of the navigation entry. A poll INTERVAL, not a guess at how long a server takes. */
const SERVED_POLL_MS = 150;

/**
 * The ceiling on waiting for a response to exist.
 *
 * It must exceed the slowest HONEST answer, because expiring early turns "still loading" into "nothing is
 * serving" -- and this guard's whole job is to distinguish those. Expiry is therefore NOT a refusal: the
 * mark says `settled: false` and the capture proceeds to the checks that can judge a document.
 */
const SERVED_BUDGET_MS = 20_000;

/**
 * WAIT FOR A RESPONSE TO EXIST BEFORE JUDGING IT.
 *
 * The first version of this read the navigation entry ONCE, immediately after the URL guard. Measured on
 * `nls.uk/join/` from a fleet worker: `landedOnRequested` matched at 898 ms because CDP reports the target's
 * PENDING url, and 397 ms later `location.href` was still `about:blank` -- so the entry read was the initial
 * blank document's, whose `responseStatus` is 0. A page that was serving perfectly was refused as unserved.
 *
 * WORSE, AND THE REASON THIS IS WRITTEN OUT: the dead-port test that "proved" the guard reported
 * `about:blank` too. It refused for the wrong reason and the green result was read as confirmation -- the
 * `refreshBrowseBuffer` defect exactly, committed inside the fix for it. A remedy must be confirmed by its
 * diagnostic MARK, not by the outcome it was expected to produce.
 *
 * So this polls for the CONDITION -- a navigation entry with `responseEnd > 0`, meaning a response
 * completed -- rather than reading at a moment that happens to be convenient. `about:blank` is never
 * judged: it is the browser's starting document, not an answer about the site.
 */
async function settledNavigation() {
  const startedAt = Date.now();
  let polls = 0;
  let outcome = null;
  while (Date.now() - startedAt < SERVED_BUDGET_MS) {
    polls += 1;
    outcome = await navigationOutcome();
    if (navigationHasAnswered(outcome)) {
      return { outcome: { ...outcome, settled: true }, waitedMs: Date.now() - startedAt, polls };
    }
    await sleep(SERVED_POLL_MS);
  }
  // NOT a refusal. `pageServedRefusal` needs a status to refuse on, and a pending navigation has none --
  // reporting one here would be the early-deadline inversion this whole function exists to remove.
  return {
    outcome: { ...(outcome ?? {}), status: null, settled: false,
      unavailable: `no response completed within ${SERVED_BUDGET_MS} ms` },
    waitedMs: Date.now() - startedAt, polls,
  };
}

/**
 * A navigation entry that describes a real document and a completed response, so it can be judged.
 *
 * MEASURED on the fleet 2026-08-28, both sides, because the first version of this guard was built on a
 * guess about what an error page reports and the guess was wrong:
 *
 *   served     url "https://www.nls.uk/join/"      status 200  responseEnd  405.4  polls 2
 *   dead port  url "chrome-error://chromewebdata/" status   0  responseEnd 2240.9  polls 9
 *
 * So `chrome-error://` IS an answer and must NOT be excluded here — it is the browser telling us it
 * committed a document without a response, which is exactly the finding. Only `about:` is excluded, and
 * only because it is the starting document the browser holds BEFORE navigating. Adding `chrome-error` to
 * that list would restore the original defect while looking like tidying.
 *
 * @param {{url?: string|null, responseEnd?: number} | null} outcome
 */
function navigationHasAnswered(outcome) {
  if (!outcome || typeof outcome !== "object") return false;
  if (typeof outcome.url === "string" && outcome.url.startsWith("about:")) return false;
  return typeof outcome.responseEnd === "number" && outcome.responseEnd > 0;
}

/** A malformed URL is a different fault, reported by the caller; here it simply means "not HTTP". */
function safeProtocol(/** @type {string} */ url) {
  try {
    return new URL(url).protocol;
  } catch (error) {
    void error;
    return "";
  }
}

/** @param {Diag} diag */
export async function waitForDocument(diag) {
  // ONE budget for all the buffer waiting this document gets, not one per attempt. Three attempts at 90 s is
  // 270 s inside a 280 s capture, so the retry loop could exhaust the whole capture before reading a word —
  // the same defect as a deadline that bounds a loop rather than the work, committed while fixing it.
  const bufferDeadline = Date.now() + BUFFER_READY_BUDGET_MS;
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt++) {
    const title = await reportedTitle(diag);
    if (title && isBrowserErrorTitle(title)) {
      // THE BROWSER'S OWN ERROR PAGE IS NOT THE PAGE. It has a title, headings and text, so every check
      // below passes and the capture is recorded as evidence about the site — measured 2026-08-25, when
      // three fixture captures came back whose first transcript line was
      // `"heading, level 1, Hmmm... can't reach this page"` from a run reporting "2/3 captured".
      //
      // Two separate causes produced it in one afternoon (no page server; a `localhost` URL a remote
      // worker cannot reach), which is the argument for catching it HERE rather than in either fix: the
      // ways to fail to reach a page are open-ended, and what they have in common is the page you get
      // instead.
      //
      // Thrown rather than marked, so the run records a failure and retries, exactly as it does for a
      // page that never loads. A capture of chrome://error is worse than no capture: it looks like data.
      diag.mark("documentReady", { ok: false, title, attempt, browserError: true });
      throw captureFault(FAULT.PAGE_UNREACHABLE,
        `the browser served an error page, not the site: ${JSON.stringify(title)}`
        + " — the URL was not reachable from this worker");
    }
    if (title && title.toLowerCase() !== "blank") {
      diag.mark("documentReady", { ok: true, title, attempt });
      return title;
    }
    diag.mark("documentReady", { ok: false, title, attempt });
    // FIRST ask whether NVDA is simply still building its buffer. On a large DOM it is, for as long as it
    // takes, and it says "Loading document..." while it works — so a blank title here means we asked too
    // early, not that the browser lost focus. Reactivating Edge in that window is useless work that also
    // steals the foreground from a screen reader mid-read.
    const buffer = await waitForBufferReady(diag, Math.max(0, bufferDeadline - Date.now()));
    if (buffer.sawLoading && Date.now() < bufferDeadline) continue;

    // Only now is the browser a plausible culprit. Bounded, via the shared helper: this call used to be a bare
    // `windowsActivate`, and it is the one that hung a real capture for 234 s, because guidepup spawns
    // `cscript` with no timeout and its WMI `Win32_Process LIKE '%msedge.exe%'` scan crawls once a heavy page
    // has Edge running dozens of renderers.
    const reactivated = await activateBrowserWithinDeadline(Date.now() + REACTIVATE_BUDGET_MS);
    if (!reactivated.ok) {
      diag.mark("reactivate", { ok: false, error: reactivated.error, via: reactivated.via, attempt });
    }
    // Same condition as the other windowsActivate site: wait for NVDA to finish announcing the
    // foreground change rather than sleeping a guess before trying again.
    await waitForSpeechQuiet("reactivateSettle");
    await anchorToTop();
  }
}

// Polling here is not a shortcut, it is the only option: guidepup's NVDA client is purely
// request/response (start, next, act, lastSpokenPhrase, spokenPhraseLog -- no emitter, no
// async iterator), so there is no "NVDA is ready" event to await. Asking costs one round
// trip and normally answers on the first attempt.
/** @param {Diag} diag */
export async function reportedTitle(diag) {
  try {
    await withTimeout(nvda.perform(nvda.keyboardCommands.reportTitle), NAV_TIMEOUT_MS, "reportTitle");
    await waitForSpeechQuiet("anchorSettle");
    return ((await withTimeout(nvda.lastSpokenPhrase(), QUERY_TIMEOUT_MS, "reportTitle")) || "").trim();
  } catch (e) {
    diag.mark("reportTitle", { error: errMsg(e) });
    return "";
  }
}

// Is NVDA already running from a previous capture, and how many has it served? Only
// meaningful when the caller asks to reuse it (the HTTP worker does; the one-shot CLI does
// not). Module-level because the screen reader is a single machine-wide resource -- there
// is exactly one of it, so exactly one place tracks it.
let screenReader = { running: false, captures: 0 };

// Start NVDA, or reuse the running instance. This is the one unrecoverable failure: with no
// screen reader there is nothing to capture, so propagate it instead of recording and
// continuing.
//
// Starting NVDA costs ~10s, and doing it per capture was 16 minutes of a 98-minute dataset
// run. Reuse skips it -- but recycles after MAX_CAPTURES_PER_NVDA so drift in a
// long-running screen reader cannot accumulate silently across a whole run.
// Returns true when NVDA was actually started, so the caller can skip the settle it only
// needs on a cold start.
// Is the NVDA we think we own actually there? `screenReader.running` is a belief, and
// anything else on the machine can invalidate it: NVDA is a single machine-wide resource, so
// another process running a capture (capture-check, a stray CLI run) stops the same NVDA this
// one is reusing. Trusting the flag cost a worker outage -- the reuse path connected to a
// dead NVDA and guidepup's socket error arrived asynchronously, outside any request handler.
//
// Probe the SOCKET, not the API. `lastSpokenPhrase()` reads guidepup's own local log of
// phrases it has already received, so it answers happily while NVDA is dead -- measured: after
// killing NVDA it still returned, the capture was reused, and the transcript came back empty.
// A liveness check that cannot detect death is worse than none, because it launders a broken
// state into a confident one.
//
// Connecting to NVDA's Remote Access port is the real question, and it is what guidepup's own
// isRunning() does (lib/windows/NVDA/isRunning.js). Done with node:net rather than importing
// that, since it is not part of the public surface.
function screenReaderResponds() {
  return new Promise((resolve) => {
    const socket = connect(NVDA_REMOTE_PORT, "127.0.0.1");
    const settle = (/** @type {boolean} */ alive) => { socket.destroy(); resolve(alive); };
    socket.setTimeout(REUSE_PROBE_MS, () => settle(false));
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
  });
}

/**
 * Poll until NVDA's Remote port answers, up to a deadline.
 *
 * Same probe `startScreenReader` uses to decide whether a reused NVDA is still alive, so this adds no
 * new failure mode -- it just stops guessing how long a cold start takes.
 */
/** @param {number} deadlineMs @param {Diag} diag */
export async function waitForScreenReader(deadlineMs, diag) {
  const deadline = Date.now() + deadlineMs;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    if (await screenReaderResponds()) {
      diag.mark("nvdaReady", { waitedMs: Date.now() - startedAt });
      return true;
    }
    await sleep(STATE_POLL_MS);
  }
  // Not fatal: ensureSpeechChannel is the real gate and runs next. Recorded so a guest that is
  // consistently slow to start is visible rather than merely slow.
  diag.mark("nvdaReady", { waitedMs: Date.now() - startedAt, timedOut: true });
  return false;
}

/** @param {Diag} diag @param {{ reuse?: boolean }} options */
export async function startScreenReader(diag, { reuse }) {
  if (reuse && screenReader.running && screenReader.captures < MAX_CAPTURES_PER_NVDA) {
    if (await screenReaderResponds()) {
      screenReader.captures += 1;
      diag.mark("nvdaStart", { ok: true, reused: true, captures: screenReader.captures });
      return false;
    }
    // Something outside this process stopped it. Fall through to a cold start rather than
    // failing the capture.
    diag.mark("nvdaGone", { after: screenReader.captures });
    screenReader = { running: false, captures: 0 };
  }
  if (screenReader.running) {
    diag.mark("nvdaRecycle", { after: screenReader.captures });
    await stopScreenReader(diag);
  }
  try {
    await startFreshWithRetry(diag);
    screenReader = { running: true, captures: 1 };
    return true;
  } catch (e) {
    // **"Already running" is success, not failure.**
    //
    // guidepup 0.31 throws when `start()` is called on a live NVDA; 0.29 tolerated it silently. That
    // tolerance was hiding a real drift: this module's `screenReader` state can legitimately disagree
    // with reality -- the worker warms NVDA at boot, `screenReaderResponds()` can miss the Remote port
    // for an instant and conclude it died, and anything outside this process can start or stop it. On
    // 0.29 the redundant start was absorbed; on 0.31 it failed the capture outright.
    //
    // Adopting the running instance is the correct resolution because NVDA being up IS the desired end
    // state, and because `ensureSpeechChannel` runs immediately afterwards and is the real gate -- an
    // adopted-but-broken screen reader is caught there, one probe later.
    //
    // Matched on message text, reluctantly: guidepup attaches no code to this error, and there is no
    // public API to ask whether NVDA is running (its own isRunning() is not exported). If a future
    // release reworded it, the symptom is the pre-0.31 behaviour returning -- a failed capture rather
    // than silent bad evidence -- which is the safe direction for this to break in.
    if (/already running/i.test(errMsg(e))) {
      screenReader = { running: true, captures: 1 };
      diag.mark("nvdaStart", { ok: true, adopted: true, reason: "already running" });
      return false;
    }
    screenReader = { running: false, captures: 0 };
    diag.mark("nvdaStart", { ok: false, error: errMsg(e) });
    throw captureFault(FAULT.SCREEN_READER_START_FAILED, "nvda.start failed: " + errMsg(e), { cause: e });
  }
}

// The FIRST capture after a guest boots very often fails with "Timed out waiting for NVDA to be
// running", and every capture after it succeeds. This was the dominant failure mode on this pool
// and it kept being misread as a broken worker: whichever VM had been up longest worked, freshly
// booted ones did not, so the fault appeared to move between guests. Windows is still settling
// after auto-logon -- the same reason `utmctl exec` does nothing for the first minute or two.
//
// One capture that takes eight seconds longer beats a run that loses its first case per worker,
// so a failed start is retried once before it becomes an error.
const NVDA_START_ATTEMPTS = 2;
const NVDA_RETRY_DELAY_MS = 8_000;

/** @param {Diag} diag */
async function startFreshWithRetry(diag) {
  let lastError;
  for (let attempt = 1; attempt <= NVDA_START_ATTEMPTS; attempt += 1) {
    try {
      await startFreshScreenReader(diag);
      return;
    } catch (e) {
      lastError = e;
      diag.mark("nvdaStartAttempt", { attempt, error: errMsg(e) });
      if (attempt < NVDA_START_ATTEMPTS) await sleep(NVDA_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

// Start NVDA, clearing a leftover instance out of the way if one is blocking us.
//
// "NVDA is already running" is a dead end otherwise: something outside this process left an
// NVDA behind — a crashed capture, a stray CLI run, a kill that did not fully take — and every
// subsequent capture fails with it while the worker keeps answering /health. Measured: the
// socket probe correctly spotted the dead screen reader, the cold start then refused, and the
// worker was stuck until a human intervened.
//
// This is still Guidepup owning the lifecycle (nvda.stop(), never taskkill), just recovering
// from a state it did not create.
// EXPERIMENT: does `{capture: true}` produce complete announcements?
// Deliberately the guidepup default, `"initial"`, after measuring the alternative.
//
// `{capture: true}` makes every keystroke wait guidepup's full 1s speech debounce, which guarantees a
// COMPLETE announcement -- with `"initial"` a log entry holds only the phrases that arrived before the
// first one resolved the promise, so a fragment can be recorded as the whole thing. That is the
// mechanism behind a button announced as `"o, button"` instead of `"Open account search, button"`,
// seen once in 48 captures.
//
// But it costs 3x: measured 19-20s per capture on `"initial"` against 58-60s on `true`, which is ~12
// hours for a corpus run instead of ~2. Preventing a 2% risk by tripling every capture is the wrong
// trade when the same defect can be DETECTED for nothing: Chromium's accessibility tree already gives
// the real accessible names on a socket this capture holds open, so `structureCrossCheck` flags a
// truncated announcement instead. Detect cheaply, do not prevent expensively.
const CAPTURE_OPTIONS = undefined;

/** @param {Diag} diag */
async function startFreshScreenReader(diag) {
  try {
    await withTimeout(nvda.start(CAPTURE_OPTIONS), NVDA_START_TIMEOUT_MS, "nvda.start");
    diag.mark("nvdaStart", { ok: true, reused: false });
    return;
  } catch (e) {
    if (!/already running/i.test(errMsg(e))) throw e;
    diag.mark("nvdaLeftover", { error: errMsg(e) });
  }
  await withTimeout(nvda.stop(), NVDA_STOP_TIMEOUT_MS, "nvda.stop")
      .catch((e) => diag.mark("nvdaStopLeftover", { error: errMsg(e) }));
  await waitForScreenReaderGone(diag);
  await withTimeout(nvda.start(CAPTURE_OPTIONS), NVDA_START_TIMEOUT_MS, "nvda.start");
  diag.mark("nvdaStart", { ok: true, reused: false, afterClearingLeftover: true });
}

// Clear NVDA's speech logs so every capture starts from the same state, reused or not.
//
// Two things go wrong without this once NVDA persists across captures, and both look like
// flakiness rather than a bug:
//
//   1. `spokenPhraseLog` is cumulative. Over 90 captures it grows without bound, and every
//      probe that reads it marshals a bigger array across the wire until the 4s query
//      timeout starts firing late in a run.
//   2. `lastSpokenPhrase` still holds the PREVIOUS capture's final phrase. The read-through
//      seeds its no-movement guard from it, so a stale phrase can be mistaken for "the
//      cursor did not move" -- the same class of bug as the phantom elements the NVDA
//      correctness audit already fixed once.
//
// Run unconditionally, not only when reusing: a reused capture should begin in exactly the
// state a cold one does, or the dataset quietly depends on which it got.
/**
 * Is the SPEECH CHANNEL alive, as opposed to NVDA merely being alive?
 *
 * These are different questions and the difference is this pipeline's most expensive fault. Guidepup
 * reaches NVDA over a TLS socket to NVDA Remote on 127.0.0.1:6837, and speech is **pushed** back over
 * that socket. Keystrokes are writes; speech is a read. So when the socket goes half-open, every
 * `nvda.next()` still succeeds — the write is accepted — while nothing is ever spoken back. NVDA looks
 * perfectly healthy and says nothing.
 *
 * Guidepup cannot notice: it only reconnects on a socket `error` event, and a half-open TCP connection
 * raises none. There is no keepalive, no read timeout and no heartbeat in its client (checked in
 * 0.29.2), and no `reconnect()` on its public API — so the only way to rebuild the channel is to restart
 * NVDA entirely.
 *
 * Hence probing, cheaply, BEFORE committing a capture to it. One round trip against ~86 s for a capture
 * that was never going to produce evidence.
 */
/** @param {Diag} diag */
async function screenReaderIsSpeaking(diag) {
  try {
    await withTimeout(nvda.clearSpokenPhraseLog(), QUERY_TIMEOUT_MS, "livenessClear");
    // Reading the current line is the cheapest command that MUST produce speech: no navigation, no
    // side effects on the page, and it works wherever the cursor happens to be.
    await withTimeout(nvda.perform(nvda.keyboardCommands.readLine), NAV_TIMEOUT_MS, "livenessRead");
    await waitForSpeechQuiet("anchorSettle");
    const heard = ((await withTimeout(nvda.lastSpokenPhrase(), QUERY_TIMEOUT_MS, "livenessHeard")) || "").trim();
    diag.mark("speechChannel", { alive: !!heard, heard: heard.slice(0, 60) });
    return !!heard;
  } catch (e) {
    // A throwing probe means the channel is not usable either, which is the same answer.
    diag.mark("speechChannel", { alive: false, error: errMsg(e) });
    return false;
  }
}

/**
 * Make sure we are about to capture through a channel that can actually carry speech.
 *
 * A restart here is bounded (one) and evidence-triggered, which is what separates it from the idle
 * warm-up loop that put modal dialogs on guest desktops: that one restarted NVDA on a timer with nothing
 * wrong. This restarts it only when the channel has been *measured* dead, during a capture, which
 * capture-core already treats as its own business.
 */
/** @param {Diag} diag */
export async function ensureSpeechChannel(diag) {
  if (await screenReaderIsSpeaking(diag)) return;

  // Cheapest remedy first: rebuild the SOCKET, not the screen reader.
  //
  // A dead channel is a dead TLS connection to NVDA Remote far more often than it is a dead NVDA --
  // NVDA's own log records nothing at all when this happens, 7 lines and zero errors, identical to a
  // healthy session. Restarting NVDA costs ~23 s and, done repeatedly, is itself what produces the
  // `nvdaHelperRemote (injection_terminate)` modal that wedges a guest. So the expensive remedy was
  // feeding the fault. See speech-channel.mjs for why guidepup cannot do this itself.
  // WHETHER A REBUILD WAS EVEN ATTEMPTED. `reset` returns false when there is no socket to destroy --
  // which is what an INERT shim looks like, and the mark below would still say "a socket rebuild did not
  // fix it". That is the `refreshBrowseBuffer` fault exactly: a remedy whose trigger was never set,
  // confirmed by a message it had no part in producing. Measured on the corpus: 1 `speechChannelReconnected`
  // with `resets: 1`, so the shim DOES adopt a real socket -- but the two `speechChannelRestart` marks
  // cannot say which of the two happened, and that is the question worth asking when one appears.
  const rebuildAttempted = speechChannel.reset("probe heard nothing before a capture");
  if (rebuildAttempted) {
    // POLL the condition; do not sleep a guess and probe once.
    //
    // The failure mode of guessing short here is not a slow capture, it is an unnecessary NVDA restart --
    // and repeated restarts are what produce the `nvdaHelperRemote (injection_terminate)` modal that
    // wedges a guest, i.e. the expensive remedy feeding the fault it treats. Guidepup's reconnect takes
    // as long as it takes; a fixed 750ms wait declared it failed whenever it took 751.
    const deadline = Date.now() + SPEECH_RECONNECT_BUDGET_MS;
    while (Date.now() < deadline) {
      if (await screenReaderIsSpeaking(diag)) {
        diag.mark("speechChannelReconnected", {
          resets: speechChannel.state.resets,
          waitedMs: Date.now() - (deadline - SPEECH_RECONNECT_BUDGET_MS),
        });
        return;
      }
    }
  }

  diag.mark("speechChannelRestart", {
    rebuildAttempted,
    connects: speechChannel.state.connects,
    reason: rebuildAttempted
      ? "no speech, and a socket rebuild did not fix it"
      : "no speech, and there was NO SOCKET to rebuild -- the shim never adopted one, so guidepup's "
        + "reconnect cannot be triggered and this restart is the only remedy left",
  });
  // Through `startScreenReader`, NOT `stopScreenReader` + `startFreshWithRetry` directly.
  //
  // Those two lines bypassed the "already running" adoption that `startScreenReader`'s catch performs,
  // and guidepup 0.31 throws when `start()` is called on a live NVDA. So whenever a stop did not take,
  // this path threw the BARE message with no fault attached — which meant `worker-recovery.mjs` and
  // `capture-decisions.mjs` could not match it, nothing recovered, and every capture afterwards returned
  // `500 {"error":"NVDA is already running","fault":null}` while `/health` still reported `ready: true`
  // with every check green. Measured on this guest: `failures: 35` against `captures: 24`, and
  // `gate:stability` degrading 5/5 -> 3/5 -> 0/5 across three runs on unchanged pages.
  //
  // The adoption fix was written for one call site when the behaviour can reach two, which is the same
  // mistake as applying the browse-mode Escape only to the post-submit re-read. `startScreenReader` with
  // `reuse: false` already stops a live instance first, so this is strictly the same work plus the guard.
  await startScreenReader(diag, { reuse: false });
  // POLL, because what follows is a thrown fault. A fixed 3s wait then ONE probe means a screen reader
  // that needed 3.1s is reported as "running but not speaking" -- a false capture failure that the run
  // classifies transient and pays for with a whole retry. Keep asking until the budget is spent; only
  // then is silence a finding.
  const freshDeadline = Date.now() + NVDA_SPEECH_BUDGET_MS;
  while (Date.now() < freshDeadline) {
    if (await screenReaderIsSpeaking(diag)) return;
  }
  throw captureFault(FAULT.SCREEN_READER_MUTE,
    "NVDA is running but not speaking: the speech channel produced nothing before this capture, and " +
    "neither a socket rebuild nor a fresh screen reader fixed it. Failing now rather than capturing " +
    "an empty page.");
}

/** @param {Diag} diag */
export async function resetSpeechLogs(diag) {
  try {
    await withTimeout(nvda.clearSpokenPhraseLog(), QUERY_TIMEOUT_MS, "clearSpeechLog");
    await withTimeout(nvda.clearItemTextLog(), QUERY_TIMEOUT_MS, "clearItemLog");
  } catch (e) {
    // Not fatal, but it means the probes' deltas start from a dirty baseline, so say so.
    diag.mark("resetSpeechLogs", { ok: false, error: errMsg(e) });
  }
}

// Wait for the old NVDA to actually let go of the port before starting a new one.
//
// A fixed settle was not enough. Restarting the worker leaves an orphaned NVDA (killing the
// node process skips the clean shutdown), and the next cold start would race its teardown:
// `nvda.start()` proceeded while the port was still in flux and the client hit
// `Cannot connect to NVDA / ECONNREFUSED 127.0.0.1:6837` -- asynchronously, so it arrived as
// an unhandled rejection and took the worker down. Recoverable, since the scheduled task
// restarts it, but it cost a capture and a restart every time.
//
// Same probe as the reuse check, inverted: ask the socket rather than guess a duration.
/** @param {Diag} diag */
async function waitForScreenReaderGone(diag) {
  const deadline = Date.now() + NVDA_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await screenReaderResponds())) return;
    await sleep(REUSE_PROBE_MS);
  }
  diag.mark("nvdaStillListening", { afterMs: NVDA_EXIT_TIMEOUT_MS });
}

/** @param {Diag} diag */
async function stopScreenReader(diag) {
  if (!screenReader.running) return;
  try { await withTimeout(nvda.stop(), NVDA_STOP_TIMEOUT_MS, "nvda.stop"); }
  catch (e) { diag.mark("nvdaStop", { error: errMsg(e) }); }
  screenReader = { running: false, captures: 0 };
}

/** Stop the shared screen reader. The HTTP worker calls this on shutdown; without it a
 * reused NVDA would outlive the process that started it. */
// Forget the reused NVDA without touching the process.
//
// Guidepup's NVDA client reports a dropped speech channel by emitting on its TLS socket, which
// surfaces as an UNHANDLED rejection ("Cannot connect to NVDA / ECONNREFUSED 127.0.0.1:6837")
// outside any await we control. The worker used to exit on that and rely on the scheduled task
// for a clean restart -- but the task demonstrably does NOT always restart it: one worker sat
// dead for over three minutes with its VM up and RestartCount 5 configured, and stayed dead.
//
// A worker that stays up and cold-starts NVDA on the next capture beats one that exits hoping
// for a babysitter. This just clears the belief that NVDA is reusable; startFreshScreenReader
// already knows how to clear a leftover instance out of the way.
// --- Readiness ------------------------------------------------------------
//
// `/health` used to answer `ok: true` unconditionally, which is exactly how the worst failure of
// this pool hid: a worker answered health while NVDA could not start, so the dispatcher handed it
// the first case and the capture died on `nvda.start`.
//
// Readiness is deliberately NOT a bag of proxies for "Windows looks settled". NVDA is normally
// started BY a capture, so probing port 6837 on a fresh worker would report not-ready forever.
// Instead the worker starts NVDA once at boot and readiness means the real thing: NVDA is up and
// answering. That makes the signal truthful, moves the cold start off the first capture's critical
// path, and turns "Windows is still settling" from a failed case into a worker that has simply not
// said ready yet.

/** Is the screen reader up and answering on its speech channel? */
export function screenReaderReady() {
  return screenReaderResponds();
}

/**
 * Is there a browser to drive at all? Cheap, and a missing browser is otherwise a mid-capture error.
 *
 * Answers for the browser this guest is CONFIGURED for, and deliberately does not fall back to another
 * one that happens to be installed. A tiny11 image ships without Edge, so a silent fallback would put two
 * browsers' evidence into one corpus — the failure the cache key exists to prevent, arriving by a
 * different door. `A11Y_BROWSER=chrome` is how such a guest says so.
 */
export function browserAvailable() {
  return resolveExe(browserFor()) !== null;
}

/**
 * Start NVDA before any capture asks for it, so the first capture reuses a warm one.
 * Never throws: a worker that cannot warm up must report why, not crash on boot.
 */
export async function warmUpScreenReader() {
  const diag = createDiagnostics();
  try {
    await startScreenReader(diag, { reuse: true });
    return { ok: true, error: null, diagnostics: diag.entries };
  } catch (e) {
    return { ok: false, error: errMsg(e), diagnostics: diag.entries };
  }
}

/**
 * NVDA's effective configuration, as guidepup reports it.
 *
 * Recorded, deliberately NOT changed. `virtualBuffers.useScreenLayout` is the obvious candidate to
 * tweak -- it is what places a field, an embedded object and a button on one line, and turning it off
 * would tidy the transcript. But it is NVDA's DEFAULT, and this project exists to capture the lived
 * assistive-technology experience: configuring NVDA away from its defaults makes the evidence less
 * representative of what a user actually hears, not more. Tidier transcripts are not the goal.
 *
 * What the configuration IS worth doing is documenting. Two guests with different NVDA settings produce
 * different evidence for the same page, exactly as two different guidepup versions did, and until now
 * nothing recorded or compared it.
 *
 * Available from guidepup 0.30.0 (`getSettings`); returns null on anything older, which is a real
 * answer rather than an error.
 */
export function screenReaderSettings() {
  try {
    return typeof nvda.getSettings === "function" ? nvda.getSettings() : null;
  } catch (error) {
    // Reading configuration must never be able to fail a capture or the diagnostics endpoint.
    return { error: String(/** @type {Error} */ (error)?.message ?? error).split("\n")[0].slice(0, 200) };
  }
}

export function forgetScreenReader() {
  screenReader = { running: false, captures: 0 };
}

export async function shutdownScreenReader() {
  const diag = createDiagnostics();
  await stopScreenReader(diag);
  return diag.entries;
}

// What does NVDA announce right after starting? Empty here means it is not
// reading the page, and the whole capture will be empty — this field is the
// first thing to check when a result comes back blank.
/** @param {Diag} diag */
export async function recordStartupHealth(diag) {
  try {
    const spoken = await withTimeout(nvda.lastSpokenPhrase(), QUERY_TIMEOUT_MS, "afterStart");
    diag.mark("afterStart", { lastSpoken: spoken || "" });
  } catch (e) {
    diag.mark("afterStart", { error: errMsg(e) });
  }
}

/**
 * @param {{ steps: number, navStrategy: string, deadline: number, diag: Diag,
 *           silentAtStart?: boolean }} request
 */
async function readPageInOrder({ steps, navStrategy, deadline, diag, silentAtStart = false }) {
  const transcript = [];
  const firstItem = await readFirstItem(diag);
  if (firstItem) transcript.push(firstItem);

  const tracker = { seen: new Set(), previous: null, repeated: 0, wrapRun: 0, silentRun: 0, silentAtStart };
  let stopReason = "maxSteps", firstStepError = null;
  for (let i = 0; i < steps; i++) {
    if (Date.now() > deadline) { stopReason = "deadline"; break; }
    let phrase;
    try {
      phrase = await advanceAndRead(navStrategy);
    } catch (e) {
      if (i === 0) firstStepError = errMsg(e);
      stopReason = "stepError";
      break;
    }
    const action = phraseAction(phrase, transcript.length, tracker);
    if (action === "keep") transcript.push(phrase);
    else if (action !== "skip") { stopReason = action; break; }
  }
  diag.mark("readThrough", { count: transcript.length, stopReason, firstStepError });
  return transcript;
}

// `nvda.next()` moves then reads, so the very first item must be read in place
// or the top line (often the first heading) is skipped.
/** @param {Diag} diag */
async function readFirstItem(diag) {
  try {
    const item = ((await withTimeout(nvda.itemText(), QUERY_TIMEOUT_MS, "itemText")
      .catch(() => "")) || "").trim();
    if (item) return item;

    // On a loaded Edge document NVDA can know the title while the virtual cursor has not
    // exposed an item to Guidepup's itemText() yet. Treating that as an empty page loses the
    // whole transcript, and waiting longer is not a state check. Ask NVDA to read the current
    // line explicitly; this is the user-visible operation we need and gives the virtual cursor
    // one more chance to materialise the first item after the anchor.
    await withTimeout(nvda.perform(nvda.keyboardCommands.readLine), NAV_TIMEOUT_MS, "readLine");
    await waitForSpeechQuiet("anchorSettle");
    const line = ((await withTimeout(nvda.lastSpokenPhrase(), QUERY_TIMEOUT_MS, "readLine")) || "").trim();
    diag.mark("readFirstItemFallback", { phrase: line });
    return line;
  } catch (e) {
    diag.mark("itemText", { error: errMsg(e) });
    return "";
  }
}

// Advance one step (line or object) and return what was announced.
/** @param {string} navStrategy */
async function advanceAndRead(navStrategy) {
  if (navStrategy === "object") await withTimeout(nvda.perform(nvda.keyboardCommands.moveToNextObject), ADVANCE_TIMEOUT_MS, "advance");
  else await withTimeout(nvda.next(), ADVANCE_TIMEOUT_MS, "advance");
  return ((await withTimeout(nvda.lastSpokenPhrase(), READ_TIMEOUT_MS, "read")) || "").trim();
}

// Read the page, and if all we heard was its title, anchor again and read once more.
//
// A degenerate capture -- transcript exactly `["<document title>"]`, no headings, no cells -- means
// the browse-mode caret was never in the document: `waitForDocument` leaves the title as the last
// spoken phrase, and a read-through that begins before the anchor takes effect reads that instead of
// the page's first line, then has nowhere to advance to. Measured on a live worker: 2 of 5 captures
// of one page.
//
// The verification layer now rejects these (captureHasSubstance), but rejecting costs the whole
// capture. A second anchor is ~3 s and usually recovers it, so it is worth trying before giving up.
// Only ONE retry: if re-anchoring did not put the caret in the document, something else is wrong and
// the capture should fail honestly rather than loop.
/**
 * @param {{ steps: number, navStrategy: string, deadline: number, diag: Diag, title: string,
 *           silentAtStart?: boolean }} request
 */
export async function readWithRetry({ steps, navStrategy, deadline, diag, title, silentAtStart = false }) {
  // The read-through stops EARLY, holding back `POST_READ_RESERVE_MS` for the phases after it.
  //
  // Measured on the W3C survey page: the read-through took 61 s of a 120 s budget and the formField sweep
  // another 43 s, so link, list and postSubmit each returned `deadline` having examined nothing — and
  // postSubmit is where 3.3.1 and 4.1.3 evidence lives. Sharing one first-come-first-served deadline meant
  // the phases carrying the criteria this tool uniquely covers were the ones that starved, purely because
  // they run last.
  //
  // Applied HERE rather than at the caller so the retry read below inherits it too. A retry that ignored
  // the reserve would spend it, which is the same starvation by a different route.
  const readDeadline = readThroughDeadline(deadline);
  diag.mark("readBudget", { readDeadlineInMs: readDeadline - Date.now(), reservedMs: deadline - readDeadline });
  const transcript = await readPageInOrder({ steps, navStrategy, deadline: readDeadline, diag, silentAtStart });
  // ONE phrase means the read never advanced, whatever that phrase was.
  //
  // The first version of this required the phrase to EQUAL the document title, and so it never fired
  // -- the kept captures proved it. The real degenerate shape was
  // `["heading, level 1, Aquarium 001 schedule"]`: the h1 announcement, not the bare title, with
  // stopReason `maxSteps`, meaning every advance produced nothing and the loop simply ran out. The
  // content of the one phrase was never the point; the failure to move was.
  if (transcript.length > 1) return transcript;

  // Do not re-read a screen reader that has already been established as silent.
  //
  // The retry below exists for a caret that never entered the document, which re-anchoring fixes. It
  // cannot fix a mute NVDA -- and measured, the wasted second read-through was most of the ~150 s a
  // mute capture cost, because every one of its 150 advances answers with silence. failIfScreenReaderIsMute
  // is about to throw on exactly this state, so returning now loses nothing and saves the whole pass.
  if (lastMark(diag, "readThrough")?.stopReason === "silent") {
    diag.mark("readThroughRetry", { skipped: "screen reader is silent; re-anchoring cannot help" });
    return transcript;
  }

  diag.mark("readThroughRetry", { reason: "read-through produced one phrase", got: transcript[0] ?? null, title });
  await anchorToTop();
  const second = await readPageInOrder({ steps, navStrategy, deadline: readDeadline, diag });
  diag.mark("readThroughRetry", { recovered: second.length > transcript.length, count: second.length });
  return second.length > transcript.length ? second : transcript;
}

// How long the speech log must stay UNCHANGED before NVDA counts as finished speaking, and how long we
// are willing to wait for that.
const SPEECH_QUIET_WINDOW_MS = 300;

const SPEECH_QUIET_BUDGET_MS = 5_000;

/**
 * Wait until NVDA stops talking, rather than sleeping a guessed duration.
 *
 * The five call sites this replaces each slept a fixed 400-500ms after a keystroke, and the repo's own
 * rule says a fixed sleep is wrong in both directions -- too long in the common case, and too short in
 * the tail, where being wrong DESTROYS evidence rather than merely costing time.
 *
 * They were not redundant, and CLAUDE.md said they were. guidepup resolves `press`/`perform` on the
 * FIRST spoken phrase, not after speech settles, because `DEFAULT_CAPTURE` is `"initial"`:
 *
 *     if ((options?.capture ?? this.#capture) === "initial") {
 *         clearTimeout(timeoutId); speakPromiseResolver();   // resolves on the first phrase
 *     } else { timeoutId = setTimeout(timeoutHandler, SPEAK_DEBOUNCE_TIMEOUT); }
 *
 * So later utterances of the same announcement can still be in flight when the call returns. The claim
 * that "nvda.perform() returning already means speech has settled" holds only for `{capture: true}`,
 * which this project does not use -- switching to it would change every log entry from the first phrase
 * to all phrases joined, which is an evidence change and a full recapture.
 *
 * Polling is the only option: the client is request/response with no emitter to await.
 *
 * @returns {Promise<{quiet: boolean, waitedMs: number, reads: number}>} `quiet: false` means the budget
 *   ran out with NVDA still talking -- recorded, never silently treated as settled.
 */
/** @param {string} label @param {number} [budgetMs] */
export async function waitForSpeechQuiet(label, budgetMs = SPEECH_QUIET_BUDGET_MS) {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let length = -1;
  let lastChange = startedAt;
  let reads = 0;
  while (Date.now() < deadline) {
    const now = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label).catch(() => [])) || []).length;
    reads += 1;
    if (now !== length) {
      length = now;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= SPEECH_QUIET_WINDOW_MS) {
      return { quiet: true, waitedMs: Date.now() - startedAt, reads };
    }
  }
  return { quiet: false, waitedMs: Date.now() - startedAt, reads };
}

// Return NVDA to a known starting point. Per the NVDA user guide: Escape
// "switches back to browse mode if focus mode was previously switched to
// automatically" (single-letter quick-nav and caret reading are browse-mode
// features, inert in focus mode); Ctrl+Home is a standard Windows caret key that
// browse mode passes through (not an NVDA command) to move to the document top.
// Moving the caret also cancels NVDA's "Automatic say all on page load" (on by
// default), so its auto-read can't race our line-stepping.
export async function anchorToTop() {
  await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "esc").catch(() => undefined);
  await withTimeout(nvda.press("Control+Home"), NAV_TIMEOUT_MS, "ctrlHome").catch(() => undefined);
  await waitForSpeechQuiet("anchorSettle");
}

// --- Teardown phase -------------------------------------------------------

// Stop NVDA and close the browser so the next capture starts fresh.
/**
 * @param {Diag} diag @param {any} browser
 * @param {{ keepScreenReader?: boolean, reuseBrowser?: boolean }} options
 */
export async function stopAndCleanup(diag, browser, { keepScreenReader, reuseBrowser = REUSE_BROWSER }) {
  if (!keepScreenReader) await stopScreenReader(diag);
  // Leaving Edge up is the entire point of reuse: closing it here would put the cold start back on
  // every capture. It is still closed on a failed capture (see captureWithNvda's finally) and when the
  // worker shuts down, so a wedged browser is never inherited indefinitely.
  if (reuseBrowser && browser && browser === reusableBrowser) {
    diag.mark("browserKeptAlive", {});
    return;
  }
  await closeBrowser(diag, browser);
}

// Close Edge and do not return until it has actually gone.
//
// The old version asked it to quit and moved on. Because captures run back to back, the
// next one could launch into a browser that was still terminating -- and NVDA then read an
// empty document, producing "blank, blank" with no error. That is the race the host-side
// retry was papering over.
//
// When we own the process this is an event, not a poll: await its "exit". The taskkill is
// the escalation for a browser that ignores the request, and the unowned fallback path.
/** @param {Diag} diag @param {any} browser */
async function closeBrowser(diag, browser) {
  // Whatever `openPage` actually launched, which is not necessarily what this request asked for.
  const app = runningApp();
  const exited = browser ? once(browser, "exit") : null;
  try {
    // Bounded: `windowsQuit` is the SAME cscript-and-WMI mechanism as `windowsActivate`, which took 342 s on
    // a loaded guest. This runs on the capture path too — `openPage` closes a browser it is recycling — so an
    // unbounded quit hangs the capture before it starts, not merely on the way out.
    await withTimeout(windowsQuit(app.image), BROWSER_QUIT_TIMEOUT_MS, "windowsQuit");
  } catch (e) {
    diag.mark("browserQuit", { ok: false, error: errMsg(e) });
  }
  if (!exited) {
    spawn("cmd", ["/c", "taskkill", "/im", app.image, "/f"], { stdio: "ignore" });
    diag.mark("browserClosed", { owned: false });
    return;
  }
  const timedOut = Symbol("timeout");
  const outcome = await Promise.race([exited, sleep(EDGE_EXIT_TIMEOUT_MS, timedOut)]);
  if (outcome === timedOut) {
    browser.kill();
    diag.mark("browserClosed", { owned: true, forced: true });
    return;
  }
  diag.mark("browserClosed", { owned: true, forced: false });
}
