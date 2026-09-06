// @ts-check
// capture-core.mjs — drive NVDA through a page and return what it announced.
// Shared by the standalone CLI (capture.mjs) and the HTTP worker (server.mjs).
// MUST run in an interactive desktop session.
//
// Every phase records a structured diagnostic (returned as `diagnostics`)
// instead of swallowing errors. When a capture comes back empty, read them in this
// order: `documentReady` (did NVDA ever name the document? ok:false means it was
// reading a blank or not-yet-rendered window), then `windowsActivate` (did Edge reach
// the foreground, and how long did it take), then `afterStart.lastSpoken`.
//
// Do NOT treat an empty `afterStart.lastSpoken` as the smoking gun on its own. It used
// to be sampled before anchoring, when NVDA legitimately had not spoken yet: across 13
// healthy captures it was empty 13 times, so it diagnosed nothing. It is now sampled
// after the document is anchored and named, which makes it meaningful.
//
// captureWithNvda reads as a top-down narrative; each phase below it is one
// level of abstraction down (the "stepdown rule").
//
// SPLIT 2026-09-05: this file used to hold the whole pipeline. `capture-setup.mjs` now owns
// bringing the browser and NVDA up, keeping them healthy, reading the page, and tearing them
// down; `capture-probes.mjs` owns the structural-navigation sweep and the ~30 probes that
// observe interaction. What is left here is the narrative itself -- `captureWithNvda` and
// `runCapturePhases` sequence phases from both of those files, which is why this file depends
// on each of them and neither depends back: that is what keeps the import graph a DAG.
import { browserFor } from "./browsers.mjs";
// Moved to its own dependency-free file so portable/host-side code can IMPORT this number instead of
// regex-scraping this file's text for it — architecture-audit.md §5, item 3. See protocol-version.mjs.
export { CAPTURE_PROTOCOL_VERSION } from "./protocol-version.mjs";
// The pure half of this module. Moved to `capture-pure.mjs` so tests can reach it without importing
// guidepup, which THROWS at import time where no screen reader exists — that is why CI was red on six
// files. Imported and re-exported here, so every existing caller of `capture-core` is unchanged and
// there is still exactly one definition of each.
import {
  addressesSamePage,
  phraseAction,
  failIfScreenReaderIsMute,
  dedupeKey,
  sweepStepFromSpeech,
  elementsListRowName,
  crossCheckStructure,
  focusOrderCycled,
  isBrowserErrorTitle,
  samePath,
  landedVerdict,
  pageServedRefusal,
  DEFAULT_BUDGET_MS,
  screenReaderWasSilentAtStart,
  shouldInstallFocusEventListenerEarly,
} from "./capture-pure.mjs";
import { setExpectedPageUrl, installFocusEventLog } from "./browser-session.mjs";
import { parkPointer } from "./pointer.mjs";
import {
  reuseBrowserFor, openPage, assertLandedOnRequestedPage, assertPageWasServed, waitForPageToSettle,
  stopAndCleanup, waitForDocument, refreshBrowseBuffer, anchorToTop, recordStartupHealth, readWithRetry,
  focusBrowserWindow, startScreenReader, waitForScreenReader, ensureSpeechChannel, resetSpeechLogs,
  errMsg,
  screenReaderReady, browserAvailable, warmUpScreenReader, screenReaderSettings, forgetScreenReader,
  shutdownScreenReader,
} from "./capture-setup.mjs";
import { navigateByStructureThenAudit } from "./capture-probes.mjs";

/**
 * @typedef {import("./capture-pure.mjs").CaptureDiagnostics} Diag
 *   The mark log, threaded through almost every function here. Aliased rather than re-described: this
 *   file passes it to forty of them, and forty inline shapes is forty chances to disagree.
 *
 * @typedef {{ asked: boolean, complete?: boolean, why?: string, activated?: number,
 *             stop?: { prev: string, next: string } }} Observation
 *   Whether this capture ASKED about a channel, and what it can support if it did — capture-protocol 9.
 *
 *   Every channel except `media` is a bare array, and a bare array cannot say why it is empty. `media` has
 *   been alone in getting this right for the whole project, with a comment saying so. Measured over 6,467
 *   corpus captures: `formChanges` empty on 4,830 with **3,006 never asked**, `postSubmitFields` 55%, and
 *   `tableCells` empty on 6,095 with NOT ONE where the tool could say the page has no table. Ten of the 28
 *   model features read only such channels, so a `0` they treat as a fact about the page is usually a fact
 *   about the request.
 *
 *   A RELOCATION rather than new instrumentation: the probe flags decide what runs and `collectByType`
 *   already records why every sweep stopped. Both went to `diagnostics`, a FORBIDDEN_INPUT_KEY — the
 *   capture's own record of its method, filed as debugging output. This makes it evidence.
 *
 *   ADDITIVE: every existing channel keeps its exact type, so the 28 files that read them are untouched and
 *   an older consumer ignores this entirely — the same shape as `fault` and `captureId`.
 *
 *   Named once because six sites write one — the eight-call-site lesson the browser preset records.
 */

// Re-exported for callers that had these from `capture-core` before the split.
export {
  addressesSamePage,
  phraseAction,
  failIfScreenReaderIsMute,
  dedupeKey,
  sweepStepFromSpeech,
  elementsListRowName,
  crossCheckStructure,
  focusOrderCycled,
  isBrowserErrorTitle,
  samePath,
  landedVerdict,
  pageServedRefusal,
};

// Re-exported for callers that had these from `capture-core` before the split into
// `capture-setup.mjs` -- same reason and same shape as the block above.
export {
  screenReaderReady,
  browserAvailable,
  warmUpScreenReader,
  screenReaderSettings,
  forgetScreenReader,
  shutdownScreenReader,
};

const DEFAULT_STEPS = 150; // read-through line count cap
const DEFAULT_BROWSER_WAIT_MS = 12_000; // UPPER BOUND on waiting for Edge, not a fixed sleep
// Deadlines for POLLS, not durations to sleep. Named as budgets so the distinction survives: every
// remaining wait in this file either checks a condition or is the interval between two such checks.
const NVDA_READY_BUDGET_MS = 3_000;   // how long a cold NVDA gets to answer at all

// A diagnostics recorder: every phase appends a timestamped entry rather than
// swallowing errors, so an empty capture can be explained after the fact.
/** @param {{ event: string, [key: string]: any }[]} [sink] @returns {Diag} */
function createDiagnostics(sink) {
  // `sink` lets the CALLER own the array. A capture abandoned by the hard timeout never returns, so every
  // phase mark it recorded died with it — which is why "the capture hung" could not be narrowed to a phase
  // on the first real website this was pointed at. The server passes an array in, keeps a reference, and can
  // report how far the capture got even when the capture itself never comes back.
  const entries = sink ?? [];
  const startedAt = Date.now();
  const mark = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ info = {}) => entries.push({ event, atMs: Date.now() - startedAt, ...info });
  return { entries, mark };
}

/**
 * @typedef {{ headings: string[], landmarks: string[], formFields: string[], graphics: string[], links: string[], lists: string[], tableCells: string[], frames: string[] }} CapturedStructure
 * @typedef {{ control: string, after: string }} AnnouncedChange
 * @typedef {{ controls: string[], stateChanges: AnnouncedChange[], formChanges: AnnouncedChange[], postSubmitFields: string[], focusOrder: string[], routeChange?: unknown, navigatedOnSubmit?: unknown, postSubmitNames?: string[] }} CapturedInteraction
 * @typedef {{ url: string, screenReader: string, capturedAt: string, transcript: string[], structure: CapturedStructure, interaction: CapturedInteraction, media?: Record<string, unknown>[] | null, observed?: Record<string, Observation>, diagnostics: object[] }} Capture
 *
 * THE EVIDENCE SHAPE, named once. It was written out inline in this `@returns` and then built by three
 * separate object literals whose inferred types disagreed with it and with each other -- so the one
 * description that was accurate was the one nothing checked. The three optional fields are optional on
 * purpose and each has a recorded reason: absent and "we looked and found nothing" must stay
 * distinguishable, because the second IS the finding for 2.4.2, 3.3.1 and 1.4.2 respectively.
 *
 * @returns {Promise<Capture>}
 *
 * @param {string} url
 * @param {{
 *   task?: string, steps?: number, maxMs?: number, nav?: string,
 *   probeForms?: boolean, probeTables?: boolean, probeFocus?: boolean,
 *   probeNavigation?: boolean, probeElementsList?: boolean, probeOrder?: string,
 *   reuseBrowser?: boolean, reuseScreenReader?: boolean,
 *   browserWaitMs?: number, diagnosticsSink?: object[],
 *   browser?: string,
 * }} [opts]
 *
 * `browser` is on that list and is NOT read as `opts.browser` anywhere here -- it goes to `browserFor(opts)`
 * whole. So a list derived by grepping `opts.` missed the one option CLAUDE.md documents as arriving per
 * REQUEST (`{"url": "...", "browser": "chrome"}`), and typechecking is what noticed. Deriving a contract
 * from how it is READ finds the fields that are read.
 *
 * DERIVED from every `opts.` this file reads, not from memory. `captureOptions` in `server.mjs` reads
 * KNOWN FIELDS ONLY -- which is what lets an older worker ignore a `captureId` it has never heard of --
 * so this list and that one are the same contract stated in two places, and the wire is the thing that
 * has to keep working across a deploy.
 */
export async function captureWithNvda(url, opts = {}) {
  const diag = createDiagnostics(/** @type {{ event: string }[] | undefined} */ (opts.diagnosticsSink));
  const reuseBrowser = reuseBrowserFor(opts);
  // Which browser this capture drives. Resolved from an allow-list, so an unknown name fails the request
  // here rather than reaching a shell; and recorded on the result, because the browser is evidence — the
  // host's cache key already reserves a slot for it.
  const app = browserFor(opts);
  diag.mark("browserSelected", { id: app.id, name: app.name });
  const browser = await openPage(url, diag, { reuse: reuseBrowser, app });
  await assertLandedOnRequestedPage(url, diag);
  await assertPageWasServed(url, diag);
  await waitForPageToSettle(diag);
  let succeeded = false;
  try {
    const result = await runCapturePhases(url, opts, diag);
    // A request can complete without throwing while NVDA is silent or still attached to a
    // blank document. Never preserve that state for the next capture: reusing it turns one
    // transient readiness failure into a whole run of confident empty captures. The host-side
    // title verifier will reject the result, but cleanup must make the worker recoverable
    // before that verifier gets a chance to retry.
    const documentReady = (result.diagnostics || []).some(
      (/** @type {Record<string, unknown>} */ event) => event.event === "documentReady" && event.ok === true,
    );
    succeeded = documentReady && Array.isArray(result.transcript) && result.transcript.length > 0;
    return result;
  } finally {
    // A worker is long-lived and serves many captures, so an expectation set by THIS capture and never
    // cleared is not an edge case, it is the normal state between requests -- every `pageTarget()` call
    // outside a capture (`/diagnostics`, a `bringPageToFront` between cases) would otherwise compare the
    // live target against the PREVIOUS capture's URL. That mostly reads as a wrong "fallback" where
    // "no-expected-url" is the truth, and two same-path pages on different hosts would make it a false
    // "matched" -- this repo's most-repeated defect, a stale value read as a current one, in a new place.
    setExpectedPageUrl(null);
    // Cleanup MUST be unconditional, and it was not.
    //
    // Edge is launched before NVDA is started, and every phase in between can throw. When
    // `nvda.start` timed out, the throw skipped the cleanup call entirely and left the browser
    // running -- so each failed capture leaked one Edge. Measured on a stuck worker: EIGHT
    // orphaned msedge processes in the logged-on session, on a 4 GB guest, which is exactly
    // the load that makes the NEXT nvda.start time out. Failures compounded until the worker
    // could not capture at all, and all three workers reached that state.
    //
    // On failure the screen reader is NOT kept, whatever the reuse setting says: a capture that
    // died mid-flight can leave NVDA running but unresponsive, and reusing that is how one bad
    // capture poisons every capture after it.
    await stopAndCleanup(diag, browser, {
      keepScreenReader: !!opts.reuseScreenReader && succeeded, reuseBrowser,
    })
      .catch((e) => diag.mark("cleanupFailed", { error: errMsg(e) }));
  }
}

// The capture proper. Split out so captureWithNvda is nothing but "launch, run, always clean
// up" -- the guarantee is the point, and it should be readable at a glance.
/**
 * Bring the machine to a state where a capture can start: window focused, pointer parked, NVDA speaking.
 *
 * One job -- everything here is setup that must succeed before the first keystroke means anything, and
 * every step of it is a condition being waited for rather than a duration being slept.
 *
 * @param {{ browserWaitMs: number, reuse: boolean, diag: Diag }} ctx
 */
async function bringUpCaptureEnvironment({ browserWaitMs, reuse, diag }) {
  await focusBrowserWindow(browserWaitMs, diag);
  // Own the pointer before anything sends a keystroke. It is a capture INPUT, not a bystander: it holds
  // hover state over whatever it rests on, and guidepup prefixes every captured action with Ctrl, which
  // Edge turns into a magnifier overlay when an image is underneath. See pointer.mjs.
  await parkPointer(/** @type {any} */ (diag));
  const coldStart = await startScreenReader(diag, { reuse: !!reuse });
  // Wait for NVDA to answer, rather than for a fixed three seconds.
  //
  // This was `sleep(NVDA_SETTLE_MS)` and its own comment conceded the point: "dead time when NVDA was
  // already running... waitForDocument below is what actually establishes readiness either way." A
  // fixed sleep is the wrong shape in both directions -- it burns the full 3s when NVDA answers in 200ms,
  // and it still expires too early when NVDA is genuinely slow.
  //
  // It cannot simply be deleted, which is the trap: `ensureSpeechChannel` runs next and treats an
  // unresponsive NVDA as a dead channel, so removing the wait would turn a slow start into a spurious
  // ~23s screen-reader restart. Polling keeps the protection and stops paying for it when it is not
  // needed. The constant is the deadline, which is why it is named as a budget.
  if (coldStart) await waitForScreenReader(NVDA_READY_BUDGET_MS, diag);
  // Before anything expensive: prove speech actually comes back. A dead channel discovered here costs one
  // round trip; discovered after the read-through it costs the whole capture and a retry.
  await ensureSpeechChannel(diag);
  await resetSpeechLogs(diag);
}

/**
 * Install the focus-event listener before the capture's OWN first `anchorToTop()`, rather than
 * immediately before `probeFocusOrder` where it used to attach — `known-gaps.md` §42's fix.
 *
 * The listener used to install well after the sweep, `probeFocusContext` and `probeFocusReveal`, any of
 * which can move real DOM focus first (a sweep activating a control under `probeForms`;
 * `probeFocusContext`/`probeFocusReveal` each walking the tab order themselves). `probeFocusOrder`'s own
 * `anchorToTop()` then blurred whatever was left focused, and that blur was the log's first event — a
 * `focusout` with no matching `focusin`, byte-for-byte 2.4.7's F55 signature and nothing of the kind, on
 * all 37 conformant real pages measured (`not-working.md` §22). Installing here means even THIS
 * function's own first `anchorToTop()` call, two lines after this one runs, is a real paired event if the
 * page autofocused something on load.
 *
 * Gated on `shouldInstallFocusEventListenerEarly` (capture-pure.mjs), not called unconditionally: without
 * `probeFocus` nothing downstream ever walks the tab order or reads this log, so installing would be a CDP
 * round trip and a page-level listener paid by every capture for evidence nothing will consume. Idempotent
 * either way -- `probeFocusOrderWithEventLog` still installs again immediately before its own walk, and
 * the page-side script's `already: true` branch makes the second call a no-op.
 *
 * @param {Record<string, any>} opts @param {Diag} diag
 */
async function installFocusEventListenerBeforeFirstFocus(opts, diag) {
  if (!shouldInstallFocusEventListenerEarly(opts)) return;
  const install = await installFocusEventLog();
  diag.mark("focusEventListenerEarlyInstall", install);
}

/** @param {string} url @param {Record<string, any>} opts @param {Diag} diag */
async function runCapturePhases(url, opts, diag) {
  const steps = Number(opts.steps || DEFAULT_STEPS);
  const browserWaitMs = Number(opts.browserWaitMs || DEFAULT_BROWSER_WAIT_MS);
  const navStrategy = opts.nav === "object" ? "object" : "line";
  const maxMs = Number(opts.maxMs || DEFAULT_BUDGET_MS);

  await bringUpCaptureEnvironment({ browserWaitMs, reuse: !!opts.reuseScreenReader, diag });

  const deadline = Date.now() + maxMs;

  // Start from a known state (browse mode + document top). Safe now that --app
  // gives a chromeless single-page window — earlier this surfaced the browser
  // start page because the window was not controlled. Also cancels NVDA's
  // auto-say-all so it can't race the read.
  // Anchor ONCE, after the gate rather than either side of it.
  //
  // There used to be an anchor here too, from when the read-through followed immediately.
  // The gate does not care where the cursor is -- reporting the document title is
  // position-independent -- and the anchor below re-establishes browse mode and the top
  // regardless, so the earlier one was pure cost: measured at ~3s of a 15.8s capture, since
  // each anchorToTop is two keystroke round trips plus a settle.
  const documentTitle = await waitForDocument(diag);
  // BEFORE the first `anchorToTop()` below -- `known-gaps.md` §42's fix. See
  // `installFocusEventListenerBeforeFirstFocus`'s own comment for why here, specifically.
  await installFocusEventListenerBeforeFirstFocus(opts, diag);
  // Anchor AFTER the gate. waitForDocument asks NVDA to report the document title, which
  // leaves that title as `lastSpokenPhrase` -- and the read-through deliberately reads the
  // current line in place before its first move, so it captured the TITLE instead of the
  // page's first line. Measured: the h1's "heading, level 1, ..." announcement disappeared
  // from every page ("heading, level N" phrases fell from 105 to 15 across 90 captures) and
  // was replaced by the <title>. Ctrl+Home moves the caret back to the top, which makes the
  // first line the last thing spoken again.
  //
  // I first blamed this on reusing NVDA between captures. It was not: the same loss happens
  // with reuse off. Both changes landed in one run, and the phrase COUNT was unchanged, so
  // neither the benchmark nor capture-check saw it.
  // Rebuild the buffer BEFORE anchoring, so Ctrl+Home lands in the new document rather than moving to the
  // top of the previous one — which is what made the fault produce a first line from the page before.
  await refreshBrowseBuffer(diag);
  await anchorToTop();
  await recordStartupHealth(diag);
  const transcript = await readWithRetry({
    steps, navStrategy, deadline, diag,
    title: documentTitle,
    silentAtStart: screenReaderWasSilentAtStart(diag),
  });
  failIfScreenReaderIsMute(transcript, diag);
  const { structure, interaction, media, observed } = await navigateByStructureThenAudit({
    deadline, diag,
    probeForms: !!opts.probeForms, probeFocus: !!opts.probeFocus, probeTables: !!opts.probeTables,
    probeNavigation: !!opts.probeNavigation,
    probeDialog: !!opts.probeDialog,
    probeFocusReveal: !!opts.probeFocusReveal,
    probeArrows: !!opts.probeArrows,
    probeTyping: !!opts.probeTyping,
    probeFocusContext: !!opts.probeFocusContext,
    // NOT a boolean, and the only capture option that is not: it carries the author's values. Passed
    // through rather than normalised here because the CLI validated it against the schema before it was
    // sent — a second, looser validation at this boundary is how two spellings of one contract begin.
    formState: opts.formState,
    probeElementsList: !!opts.probeElementsList,
    probeOrder: opts.probeOrder === "focus-first" ? "focus-first" : undefined,
    task: opts.task,
  });

  diag.mark("done", { transcript: transcript.length });
  return {
    url,
    screenReader: "NVDA",
    capturedAt: new Date().toISOString(),
    transcript,
    structure,
    interaction,
    // 1.4.2 evidence, from the DOM. `null` means the probe did not run and is NOT the same as an empty
    // array, which means the page declares no media — the rule reading this makes no claim on null.
    media,
    // What this capture ASKED, beside what it heard. See the `Observation` typedef.
    observed,
    diagnostics: diag.entries,
  };
}
