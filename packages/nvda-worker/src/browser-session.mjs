// @ts-check
/**
 * Keep one Edge alive across captures and re-point it, instead of cold-starting Chromium every time.
 *
 * ## Why
 *
 * `windowsActivate` — which is really "wait for Edge to exist and take focus" — is the largest single
 * phase of a capture, and it is Chromium's cold start. Measured on this fleet:
 *
 *   one guest running     windowsActivate  8.9 s of a 12.6 s capture
 *   three guests running  windowsActivate ~15.2 s on ALL THREE, uniformly
 *
 * That uniform inflation is the signature of a SHARED resource, and it is not RAM: guest residency is
 * 0.9-1.6 GB and cold pages compress fine. Three guests cold-starting Chromium contend on one SSD. The
 * consequence measured end to end is that the pool does not scale at all — 1 worker gives 0.079
 * captures/s, 2 give 0.076, 3 give 0.072. **Adding workers made throughput worse.** Removing the cold
 * start attacks the per-capture cost and the contention that caps the pool, in one change.
 *
 * ## Why the DevTools Protocol rather than reusing the window
 *
 * Captures run `--app`, which is a chromeless window with no address bar, so there is no UI route to
 * navigate an existing window — and abandoning `--app` resurfaces the browser chrome that NVDA used to
 * wander into (the "Welcome to Microsoft Edge" phantoms). Opening a second `--app` window per capture
 * and closing it again would work, but closing the LAST window exits the process, so it needs a keeper
 * window and Alt+F4 aimed at the right target. That is window-focus juggling, which this project's own
 * notes call the #1 flakiness fix — not somewhere to be clever.
 *
 * `Page.navigate` re-points the window that already exists. No new window, no focus transition, no
 * process start.
 *
 * ## ON by default
 *
 * A reused browser is a different evidence-production environment from a fresh one: a persistent
 * renderer keeps session state, and a page loaded by navigation may announce differently from one loaded
 * into a new window. That is exactly what `npm run evidence:check` exists to answer, and it has — so the
 * gate is passed and this is the normal path, disabled with `A11Y_REUSE_BROWSER=0`.
 *
 * Worth knowing before reading `edgeArgs`: the DevTools port is added by `reusableArgs`, not by the
 * one-shot launch, so CDP is available exactly because reuse is the default. The census and
 * `currentPageUrl` depend on it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { samePath , resolvedNavigationUrl } from "./capture-pure.mjs";

/** Chromium's DevTools endpoint. Loopback only — it is never reachable off the guest. */
export const CDP_PORT = 9222;
const AX_TREE_TIMEOUT_MS = 5_000;
const CDP_HOST = "127.0.0.1";

/**
 * How long Edge gets to open its DevTools port.
 *
 * Was 20 s, which is generous for a dataset page and far too tight for a real one: launching with `--app=URL`
 * starts LOADING the page, so on a heavy site on a 3 GB guest the port opened well past 20 s and the reusable
 * launch was declared failed — after which the fallback relaunched Edge and paid the cost twice, inside a
 * 280 s capture budget. Raised deliberately, and it is still a bound: an Edge that has not answered in a
 * minute is broken, not busy.
 */
const CDP_READY_TIMEOUT_MS = 60_000;
const CDP_POLL_MS = 200;
const NAVIGATE_TIMEOUT_MS = 30_000;

const endpoint = (/** @type {string} */ path) => `http://${CDP_HOST}:${CDP_PORT}${path}`;

/**
 * Arguments for a reusable Edge.
 *
 * Identical to the one-shot launch except for the debugging port, deliberately: every other flag is
 * load-bearing for what NVDA hears, and changing any of them would confound an evidence comparison.
 *
 * @param {string} url
 * @param {string[]} baseArgs the flags the one-shot launch already uses
 */
export function reusableArgs(url, baseArgs) {
  return [...baseArgs, `--remote-debugging-port=${CDP_PORT}`];
}

/** Is a reusable browser answering on the DevTools port? */
export async function browserAlive() {
  try {
    const response = await fetch(endpoint("/json/version"), { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false; // not running, or not listening yet — both mean "launch one"
  }
}

/**
 * The URL `openPage` most recently pointed the browser at, so `choosePageTarget` can tell a genuine
 * capture target from a third-party widget's own CDP target — see the finding this fixes, recorded in
 * `docs/backlog.md`: two unrelated real sites returned a byte-identical census because a Cookiebot
 * consent iframe surfaced its own `type: "page"` target and `choosePageTarget` took the first one.
 *
 * Module-level rather than threaded as a parameter through the ~8 functions that call `pageTarget` and
 * the 14 places in `capture-core.mjs` that call THOSE — every one of them already means "what is CDP
 * showing me right now, for the capture `openPage` most recently started", so a parameter would repeat
 * the same value at every call site for no reader's benefit. `setExpectedPageUrl` is the one seam that
 * needs to know it, and it already receives the URL.
 *
 * @type {string | null}
 */
let expectedPageUrl = null;

/**
 * Record which URL the capture believes it is showing.
 *
 * Called from `openPage` on BOTH paths — reuse (`navigateExisting`) and a fresh launch — because a fresh
 * launch never calls anything in this module to get there: the URL is a `--app=` command-line flag, so
 * this module cannot infer it from a navigation it did not perform.
 *
 * @param {string | null | undefined} url
 */
export function setExpectedPageUrl(url) {
  expectedPageUrl = url || null;
}

/**
 * Read the current value, for the one thing `pageTarget` cannot be unit-tested through: it does a real
 * `fetch` to CDP, so the reset `captureWithNvda`'s `finally` now performs on every capture -- the fix for
 * "a worker is long-lived, so the PREVIOUS capture's URL was never cleared" -- has to be asserted here
 * instead, on the state itself, the way `comparableNamesForTest` exposes a rule-layer internal for the
 * same reason.
 */
export function expectedPageUrlForTest() {
  return expectedPageUrl;
}

/**
 * Do two URLs identify the same document, allowing for the differences a real capture actually sees?
 *
 * Deliberately compares PATH AND QUERY ONLY — never scheme, host or port. Two facts from this repo's own
 * corpus made that the right line to draw, not a guess:
 *
 *   - Every synthetic fixture is declared against `localhost:5050` in `case-matrix.mjs` and served from
 *     whichever lab box runs the capture, e.g. `<the lab's address>:5050` — a real, permanent host mismatch on
 *     every synthetic capture this project has ever taken, not a hypothetical.
 *   - The contaminating target is never confusable by PATH: a Cookiebot consent panel's own document has
 *     a path like `/what-is-behind-powered-by-cookiebot`, nothing close to `/action-weve-taken/enforcement/`
 *     or `/council-tax`. Path is the dimension that actually discriminates a widget from the page under
 *     test; host and port are the dimensions this project has already proven unreliable.
 *
 * PATHS ARE COMPARED WITH `samePath`, not a bespoke normalisation, and this was a real gap until
 * 2026-09-05: every synthetic page is REQUESTED with `.html` and the page server serves the extensionless
 * path the browser then reports, so this function tagged `fallback` on every synthetic capture ever
 * taken -- undetected because a single-target page still falls back onto the right document, so no
 * evidence was ever wrong. `samePath` (`capture-pure.mjs`) already exists to solve exactly this: it was
 * written for `landedVerdict`/`addressesSamePage` after an identical incident (`serve` logging
 * `GET /route-title-stale/bad` for a request to `/bad.html`) and already normalises the extension, a
 * trailing slash AND an `/index` suffix -- a superset of "tolerate `.html`", proven against a real
 * incident rather than invented for this file. Writing a second, narrower normaliser here would be this
 * repo's own "a fact stated twice" shape: two hand-rolled answers to "is this the same document" that
 * could disagree the next time the page server's rewrite rule changes. Reusing it keeps the comparison
 * against the REQUESTED `expectedUrl`, never the browser's own report of where it landed -- CDP's
 * `target.url` is exactly the value this function exists to doubt, so trusting it as the oracle would
 * remove the check it is performing.
 *
 * The hash is ignored because an in-page anchor never changes which document is showing.
 *
 * @param {string | undefined} actualUrl @param {string} expectedUrl
 */
function sameDocument(actualUrl, expectedUrl) {
  if (!actualUrl) return false;
  if (actualUrl === expectedUrl) return true;
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return samePath(actual.pathname, expected.pathname) && actual.search === expected.search;
  } catch {
    return false; // either URL failed to parse -- not a match, never a crash
  }
}

/**
 * The page target to drive.
 *
 * Pure so the selection rule is testable. Chromium lists more than pages — service workers, extension
 * backgrounds, the DevTools UI itself, and (the defect this now guards against) a third-party widget's own
 * navigable document — and picking the wrong one either does nothing to the visible window (a stale
 * navigate) or, for `structuralCensus`/`domCensus`, silently reads a different document's numbers as the
 * page's own.
 */
/**
 * How many candidate target URLs a census records when the choice was ambiguous.
 *
 * A cap rather than all of them: this rides on every census mark of every capture, and the question it
 * answers -- "which OTHER document was Edge offering?" -- is answered by the first few. Four covers the
 * measured worst case (2) with room, and a page with forty targets is a different investigation.
 */
const CANDIDATE_URLS_RECORDED = 4;

/**
 * @typedef {{ type?: string, url?: string, webSocketDebuggerUrl?: string }} CdpTarget
 * @typedef {CdpTarget & { webSocketDebuggerUrl: string,
 *   targetMatch: "matched" | "fallback" | "no-expected-url", candidates: number,
 *   candidateUrls: (string | null)[], resolvedUrl?: string }} UsablePageTarget
 *
 * The `filter` below already REQUIRES `typeof webSocketDebuggerUrl === "string"`, so a returned target
 * always has one -- but a predicate inside `find`/`filter` cannot narrow the result, and every caller then
 * reads a possibly-undefined URL straight into `new WebSocket`. The second typedef states what the filter
 * has already established rather than re-checking it at four call sites.
 *
 * `targetMatch` is additive on the existing shape rather than a wrapper object, so none of the ~8 existing
 * callers that only ever read `.webSocketDebuggerUrl` or `.url` need to change. It exists so a caller that
 * DOES care — `structuralCensus` and `domCensus`, which write a diagnostic mark — can record which of the
 * three things happened, because a fallback that looks identical to a match is the same defect this fixes,
 * wearing a different coat: "matched" (found the page we navigated to), "fallback" (nothing matched, so we
 * took the first usable target, exactly as before this fix — a page that redirected or normalised its own
 * URL is the expected reason, not a wrong document), "no-expected-url" (nothing was recorded to compare
 * against, e.g. a call before `openPage` ever ran).
 *
 * `candidates` (`pages.length`) travels for the same reason `targetUrl` does on `evaluateOnPageTarget`'s
 * result: `targetMatch: "fallback"` alone cannot say whether the fallback was FORCED (two page-type
 * targets, a vendor widget among them, neither one confirmed) or VACUOUS (exactly one target existed, so
 * the fallback and the only correct answer are the same target). `docs/backlog.md`'s own account of the
 * bathingwaters/lbhf contamination makes this the whole difference: a consumer reading `targetMatch` alone
 * cannot tell a genuinely suspect census from a perfectly safe one, and would either accuse too much or
 * too little. `candidates <= 1` is what makes "fallback" safe; `> 1` is what makes it worth doubting.
 *
 * @param {CdpTarget[] | null | undefined} targets
 * @param {string | null} [expectedUrl]
 * @returns {UsablePageTarget | null}
 */
export function choosePageTarget(targets, expectedUrl, resolvedUrl = /** @type {string | null} */ (null)) {
  const pages = /** @type {(CdpTarget & { webSocketDebuggerUrl: string })[]} */ ((targets ?? []).filter((t) =>
    t.type === "page" && typeof t.webSocketDebuggerUrl === "string" && !t.url?.startsWith("devtools://")
  ));
  if (!pages.length) return null;
  const candidates = pages.length;
  // THE URLS, NOT JUST THE COUNT -- added 2026-09-06 because an investigation stopped on the count.
  //
  // `rules:real-pages` reported 30 of 85 conformant real pages with a census it does not trust, each
  // saying `targetMatch: "fallback", candidates: 2` and nothing else. That is enough to REFUSE the census,
  // which is the right call and is why the number is 30 rather than a corpus of wrong documents. It is not
  // enough to FIX anything: the whole question is WHICH second target Edge was offering -- a consent
  // vendor's iframe promoted to a page target, an about:blank the `--app` window left behind, or the real
  // page under a URL it normalised itself -- and those need three different remedies.
  //
  // This is `graphicUnnamed`'s defect exactly, one field along: a count with no identity, which tells you
  // an investigation cannot proceed rather than letting it proceed. That one was fixed the same way, by
  // recording `graphicUnnamedDetail` beside the number, and it is what made the ONS 1.1.1 finding
  // adjudicable in one read instead of a live-site expedition.
  //
  // Bounded and diagnostic-only: the FIRST FEW urls, never the target objects (a `webSocketDebuggerUrl`
  // is a live handle, not evidence), and every consumer already treats this whole block as a diagnostic
  // rather than as evidence -- `capture-probes.mjs` takes `.elements` only, saying so at its own call site.
  const candidateUrls = pages.slice(0, CANDIDATE_URLS_RECORDED).map((t) => t.url ?? null);
  if (!expectedUrl) return { ...pages[0], targetMatch: "no-expected-url", candidates, candidateUrls };
  const match = pages.find((t) => sameDocument(t.url, expectedUrl));
  if (match) return { ...match, targetMatch: "matched", candidates, candidateUrls };
  // THE REDIRECT CASE. Nothing matched what we ASKED for, so ask where our own navigation actually landed
  // -- the chain bracketed by `Page.navigate` and its `loadEventFired` (`resolvedNavigationUrl`). A page
  // that redirects is not a page we failed to find, and reporting it as `fallback` is what makes
  // `censusTargetIsSuspect` suppress a census of the right document.
  //
  // `matched` WITH `resolvedUrl` ALONGSIDE, rather than a new `matched-after-redirect` state, and the
  // reason is scope rather than preference. A distinct state is arguably the better model -- "the URL we
  // asked for" and "the URL our request resolved to" are different facts, and this repo's rule is not to
  // collapse states. But `targetMatch` is read by `censusSuspectReason` (packages/evidence/src/verify.ts)
  // and by `focusTargetIsSuspect` (capture-pure.mjs), which are pinned equal by
  // `focus-target-suspect-parity.test.ts`; a fourth value changes SUPPRESSION SEMANTICS in another package
  // and would have to land with both twins and the parity table at once.
  //
  // So the redirect is not hidden, it is RECORDED: `resolvedUrl` rides on the target and reaches the mark,
  // so `targetMatch: "matched"` beside a `resolvedUrl` that differs from the requested URL says exactly
  // what happened. A reader can tell the two apart; no downstream trust rule has to learn a new word.
  // `sameDocument` rather than `!==`, for consistency with every other URL comparison here -- but NOT as a
  // bug fix, and the difference matters enough to record.
  //
  // It was reported as one: a raw `!==` calls a page "redirected" when the resolved URL differs only by
  // NORMALISATION, which on the dataset page server is a same-every-time difference. Plausible, and
  // REFUTED by the branch ordering directly above. `pages.find(sameDocument(t.url, expectedUrl))` returns
  // at the line before this one, so this branch is reached ONLY when nothing matched what we asked for --
  // and if `resolvedUrl` is the same document as `expectedUrl`, anything matching it would have matched
  // there. `!==` could be true here and still find nothing. Mutation-checked: restoring `!==` fails no
  // test, because there is no case where it changes the answer.
  //
  // So the `postSubmitNames` movement is NOT explained by this line. See `resolvedPageUrl`'s reset below,
  // which reaches this branch for real.
  if (resolvedUrl && !sameDocument(resolvedUrl, expectedUrl)) {
    const afterRedirect = pages.find((t) => sameDocument(t.url, resolvedUrl));
    if (afterRedirect) {
      return /** @type {UsablePageTarget} */ (
        { ...afterRedirect, targetMatch: "matched", candidates, candidateUrls, resolvedUrl });
    }
  }
  return { ...pages[0], targetMatch: "fallback", candidates, candidateUrls };
}

/**
 * How long Edge gets to list its targets, and how many tries.
 *
 * Was a single attempt at 5 s, and that lost the STRUCTURAL CENSUS on the one page that most needed it: 150 s
 * into a capture of a real site, with Edge busy, `/json/list` did not answer in time and the census came back
 * `null` with "fetch failed". The census is the AX tree's own count of links, graphics and controls — the
 * ground truth against which a sweep's coverage can be stated as a number rather than as the word
 * "INCOMPLETE". Losing it exactly when the page is large is losing it exactly when it matters.
 *
 * Retried because a busy Chromium answers late, not never — and still bounded, because this sits inside a
 * capture budget.
 */
const CDP_LIST_TIMEOUT_MS = 15_000;
const CDP_LIST_ATTEMPTS = 3;
const CDP_LIST_RETRY_MS = 750;

/** @returns {Promise<UsablePageTarget>} */
async function pageTarget() {
  let last;
  for (let attempt = 1; attempt <= CDP_LIST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(endpoint("/json/list"), {
        signal: AbortSignal.timeout(CDP_LIST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
      const target = choosePageTarget(await response.json(), expectedPageUrl, resolvedPageUrl);
      if (!target) throw new Error("CDP listed no page target to navigate");
      return target;
    } catch (error) {
      last = error;
      if (attempt < CDP_LIST_ATTEMPTS) await new Promise((r) => setTimeout(r, CDP_LIST_RETRY_MS));
    }
  }
  // Rethrow with the cause, so a caller sees WHY rather than a bare "fetch failed" after three silent tries.
  throw new Error(`CDP /json/list did not answer in ${CDP_LIST_ATTEMPTS} attempts`, { cause: last });
}

/**
 * Point the existing window at a new URL and wait for the load event.
 *
 * Waiting for `Page.loadEventFired` rather than returning on the navigate acknowledgement matters: the
 * caller's next move is to ask NVDA to read the document, and reading a page that has not finished
 * loading is precisely the "blank, blank" transcript this pipeline already learned to avoid.
 */
/**
 * `resolvedPageUrl` is where the LAST navigation actually landed, and it exists because the requested URL
 * is not always the document being shown.
 *
 * `sameDocument` compares a CDP target against the REQUESTED url, so a page that redirects reads as a
 * different document, `choosePageTarget` returns `targetMatch: "fallback"`, and
 * `censusTargetIsSuspect`/`focusTargetIsSuspect` then suppress census findings and `focusEvents` on a page
 * that was the right one all along.
 *
 * KEPT SEPARATE FROM `expectedPageUrl`, DELIBERATELY, and this is the half that is easy to lose. The
 * requested URL stays the oracle for "did we land on the page we asked for" — `addressesSamePage` and the
 * error-page guards still compare against it, so a redirect to a different host is still caught. This
 * value answers only the narrower question `choosePageTarget` asks: of the targets Edge is offering, which
 * one is the document our own navigation ended on. Overwriting `expectedPageUrl` with it would remove the
 * wrong-page check entirely, which is the objection `sameDocument`'s own comment raises.
 */
/** @type {string | null} */
let resolvedPageUrl = null;

/** Where the last navigation resolved to, or null when nothing has navigated in this capture. */
export function lastResolvedPageUrl() {
  return resolvedPageUrl;
}

/** @param {string} url */
export async function navigateExisting(url) {
  // FIRST STATEMENT, BEFORE `pageTarget()`, and the position is the whole fix.
  //
  // The reset used to sit below, inside the try, after the socket opened -- and its own comment named the
  // exact call it failed to protect: *"`pageTarget()` runs at the TOP of the next `navigateExisting`,
  // before that capture has navigated, so capture N+1 of page B would call `choosePageTarget(expectedUrl =
  // B, resolvedUrl = A)`"*. `pageTarget()` reads this module-level value on its way to `choosePageTarget`,
  // and it ran first. So the comment described the defect and the code was ordered the other way round:
  // a correct diagnosis one line above a statement placed where it could not act on it.
  //
  // THE FAILURE LOOKS LIKE SUCCESS, which is why nothing caught it. A stale `resolvedPageUrl` is a real
  // URL from the previous capture, so it does not throw and does not read as absent -- it makes
  // `choosePageTarget` accept the document the reused window is still showing as a legitimate match for
  // the page we are about to request. `A11Y_REUSE_BROWSER` is ON by default, so that is the normal path.
  //
  // Reset before anything can read it: the value is then only ever "where THIS navigation landed", or
  // null. `browser-session.test.ts` pins the ordering, because a statement's POSITION is the property
  // here and moving it back is a one-line edit that changes nothing a type or a lint check can see.
  resolvedPageUrl = null;
  const target = await pageTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  // THE BRACKETS ARE THE MECHANISM. Collection starts before `Page.navigate` is sent and the resolved URL
  // is taken no later than its `loadEventFired` -- outside that window a `frameNavigated` is just the
  // browser reporting where a target sits, which is the value `sameDocument`'s comment refuses to trust.
  // Rooted inside it, the chain is the redirect trail of a navigation we ourselves caused.
  /** @type {{method?: string, params?: {frame?: {url?: string, parentId?: string}}}[]} */
  const events = [];
  socket.addEventListener("message", (event) => {
    try {
      events.push(JSON.parse(String(event.data)));
    } catch (error) {
      void error; // not a frame we can read; the resolver treats absence as "no redirect seen"
    }
  });
  try {
    await once(socket, "open", CDP_READY_TIMEOUT_MS);
    // The reset that used to be here is now the first statement of this function -- see the comment
    // there. `resolvedNavigationUrl` returns the REQUESTED url when nothing redirected, so this value
    // never becomes null on its own: after a capture of page A it holds A until something clears it.
    const loaded = waitForMethod(socket, "Page.loadEventFired", NAVIGATE_TIMEOUT_MS);
    socket.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    socket.send(JSON.stringify({ id: 2, method: "Page.navigate", params: { url } }));
    await loaded;
    resolvedPageUrl = resolvedNavigationUrl({ events, requested: url }).url;
  } finally {
    try {
      socket.close();
    } catch (error) {
      // A socket that will not close is not a failed capture; the navigate already happened.
      void error;
    }
  }
}

/**
 * Landmark roles, per ARIA. `region` is deliberately conditional -- see `censusFromAXTree`.
 */
const LANDMARK_ROLES = ["main", "navigation", "banner", "contentinfo", "complementary", "search", "form", "region"];

/**
 * NVDA'S OWN FORM-FIELD ALPHABET, which is not the DOM's.
 *
 * `dom.formField` counts `input, select, textarea, [role=textbox], [role=combobox]`, and that set is
 * correct for what it does -- it is 2.1.2's denominator of things a dialog can hold. It is the WRONG
 * oracle for `structure.formFields`, because NVDA's `f` quick-nav also walks buttons, checkboxes, radios,
 * sliders and switches. Comparing the sweep against the DOM count would report a phantom on every page
 * carrying a button: two alphabets compared as one, which is the defect `capture-integrity-plan` is about
 * and which this file has already paid for twice (U+FFFC, U+E604).
 *
 * So the oracle is counted HERE, from the accessibility tree, over the roles NVDA actually visits.
 * Deliberately a separate bucket from `dom.formField` rather than a widening of it: that count is load
 * bearing for 2.1.2 and changing it would move a denominator this is not about.
 */
/** @type {string[]} */
const FORM_CONTROL_ROLES = [
  "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch",
  "slider", "spinbutton", "button", "menuitemcheckbox", "menuitemradio",
];

/**
 * Role -> which sweep it belongs to. A lookup rather than a branch chain: the chain put this function
 * over the complexity gate, and naming the mapping once is clearer than restating it in `else if`s.
 */
/** @type {Map<string, string>} */
const ROLE_BUCKET = new Map([
  ["heading", "heading"], ["link", "link"],
  ["image", "graphic"], ["img", "graphic"], ["graphics-document", "graphic"],
  .../** @type {[string, string][]} */ (FORM_CONTROL_ROLES.map((role) => [role, "formControl"])),
  .../** @type {[string, string][]} */ (LANDMARK_ROLES.map((role) => [role, "landmark"])),
]);

/**
 * How many structural elements does the PAGE actually expose?
 *
 * This is a completeness ORACLE, never evidence. The distinction is the whole design: what a screen
 * reader announced is the evidence, and `docs/local-model.md` forbids the accessibility tree as a model
 * feature. But a sweep that under-reports is indistinguishable from a page that has nothing -- and that
 * is exactly the defect this exists to catch. `structure.landmarks` misses a `<main>` wrapping the page
 * on 2,063 of 2,064 corpus captures, because quick navigation cannot reach a landmark containing the
 * caret, and nothing could see it.
 *
 * Asking Chromium costs one CDP call on a socket that is already open: milliseconds, no keystrokes, no
 * modal dialog. The alternative -- reading NVDA's own Elements List -- is authoritative but costs ~11s
 * per capture for landmarks alone, because every keystroke waits on guidepup's 1s speech-quiet
 * debounce. At 2,122 captures that is the difference between a verification you run always and one you
 * can never afford.
 *
 * @param {Array<{role?: {value?: string}, name?: {value?: string}, ignored?: boolean}>} nodes
 *   `Accessibility.getFullAXTree`'s flat node list.
 */
/**
 * Which bucket this node counts toward, and whether it is nameless — or null when it counts toward none.
 *
 * Split out of `censusFromAXTree` because the two jobs are separable: this one classifies a single node,
 * the caller accumulates. It also put the census over the complexity gate, and the honest fix for that is a
 * named function rather than a bigger limit.
 */
/**
 * Is this AX node CSS-generated content rather than an element on the page?
 *
 * `Accessibility.getFullAXTree` gives every DOM-backed node a `backendDOMNodeId`; generated content -- a
 * `<::marker>` bullet, a `::before` with `content:` -- has none, and a negative synthetic `nodeId` instead.
 * Named because the absent field is a CDP implementation detail and "generated content" is the thing being
 * decided; `classifyAXNode` explains WHY it must not be counted.
 */
/** @param {Record<string, any>} node */
function isGeneratedContent(node) {
  return node.backendDOMNodeId == null;
}

/**
 * Count an unnamed graphic AND record what was counted — "a count is where an investigation stops".
 *
 * Added 2026-09-04, and it cost a blocked pipeline to learn. `rules-real-pages` refused a run with one new
 * 1.1.1 finding on cqc.org.uk, `graphicUnnamed=2`, and its own output says "Read the evidence for each
 * before doing anything else". There was no evidence: the capture held the NUMBER and nothing about the
 * two nodes, so neither it nor the live page could separate the rule's three causes. The live page cannot
 * in principle — these are sites their publishers edit, so the page today is not the page captured.
 *
 * `ancestorName` is the field that decides the question the finding raises. 1.1.1's Controls/Input
 * exception says "If non-text content is a control or accepts user input, then it has a NAME that
 * describes its purpose", so an image inside a NAMED control already conforms through that control's name
 * and counting it is a false positive — while an exposed unnamed image in NO control is a real finding.
 * Opposite responses, and the count could not tell them apart.
 *
 * Bounded at 12: a diagnostic on a page with hundreds of unnamed images must not become the cost of the
 * capture.
 *
 * @param {Record<string, any>} census @param {any} node @param {Map<string, any>} byId
 */
function recordUnnamedGraphic(census, node, byId) {
  const found = nearestNamedAncestor(node, byId);
  // 1.1.1'S CONTROLS/INPUT EXCEPTION, enforced 2026-09-04 rather than merely documented.
  //
  //   "If non-text content is a control or accepts user input, then it has a NAME that describes its
  //    purpose."
  //
  // An image inside a NAMED control already satisfies 1.1.1 through that control's name -- `name` is
  // defined as "text by which software can identify a component within web content to the user", which
  // the image itself need not carry. Counting it is a false positive, and it WAS one: `rules-real-pages`
  // refused two verdict runs on `1.1.1 cqc.org.uk/search/all?query=hospital`, and the capture's own
  // detail says both nameless images sit inside a link named "The Care Quality Commission" -- the site's
  // logo, marked up exactly as it should be.
  //
  // The criterion audit predicted this class from reading the text, hours before an instance arrived. The
  // instance is what let it be FIXED rather than argued: a count could not tell "inside a named control"
  // from "in no control at all", and those need opposite responses.
  //
  // NOT a blanket ancestor test. Only a CONTROL's name discharges the requirement, because that is what
  // the exception says -- an image inside a named `region` or `article` is still an unnamed image the
  // user meets, and is still a finding.
  //
  // `controlRole`/`controlName`, not `ancestorName`/`CONTROL_ROLES.has(ancestorRole)` -- see
  // `nearestNamedAncestor`'s own comment for why the old proxy under-exempted through a named non-control
  // wrapper. The two fields answer the exception's actual question: is there a control ancestor, and is
  // THAT one named.
  if (found.controlRole && found.controlName) {
    // THE EXEMPTED POPULATION, MADE VISIBLE. Added 2026-09-06 for the same reason `graphicUnnamedDetail`
    // was: an image that is correctly exempted left no record at all, so a 92-page search of the
    // ALTERNATIVE (the finding side) could confirm "none of these 19 exhibit the shape" but could not
    // examine the population where the shape would actually hide -- an exemption firing on the WRONG
    // ancestor is invisible unless the exemption itself says which ancestor it used. Bounded for the same
    // reason its sibling is: a page with hundreds of exempted icons must not become the cost of the capture.
    if (census.graphicExemptedDetail.length < 12) census.graphicExemptedDetail.push(found);
    census.graphicExempted += 1;
    return;
  }
  census.graphicUnnamed += 1;
  if (census.graphicUnnamedDetail.length < 12) census.graphicUnnamedDetail.push(found);
}

/**
 * Roles whose accessible NAME can discharge 1.1.1 for an image inside them.
 *
 * The criterion's exception is "if non-text content is a CONTROL or ACCEPTS USER INPUT", so this is the
 * set of things a user operates -- not every named ancestor. A named `region` or `figure` wrapping a
 * nameless image leaves the image unidentifiable, which is the finding rather than an exception to it.
 */
const CONTROL_ROLES = new Set([
  "link", "button", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "tab", "switch", "textbox", "combobox", "searchbox", "slider", "spinbutton",
  "treeitem", "disclosuretriangle",
]);

/**
 * Fold one ancestor into the two answers being tracked, WITHOUT overwriting one already settled -- each
 * answer is "the FIRST time this became true, walking outward", so a later, more distant ancestor must
 * never replace an earlier one. Split out of `nearestNamedAncestor` purely to keep that function's
 * complexity under gate: two independent trackers updated per step is what pushed it over, not a second
 * concept -- this is the exact same per-ancestor decision, written out where it can be named.
 *
 * @param {{ ancestorName: string|null, ancestorRole: string|null, controlRole: string|null,
 *           controlName: string|null }} found
 * @param {any} ancestor
 */
function noteAncestor(found, ancestor) {
  const name = String(ancestor.name?.value ?? "").trim();
  const role = String(ancestor.role?.value ?? "").toLowerCase();
  if (found.ancestorName === null && name) {
    found.ancestorName = name.slice(0, 60);
    found.ancestorRole = role;
  }
  if (found.controlRole === null && CONTROL_ROLES.has(role)) {
    found.controlRole = role;
    found.controlName = name ? name.slice(0, 60) : null;
  }
  return found;
}

/**
 * The closest ancestor of an unnamed node that HAS a name, AND separately the closest ancestor whose ROLE
 * is a CONTROL — the exception's own question, asked directly rather than through the "nearest named
 * ancestor happens to be a control" proxy that used to be the only thing computed here.
 *
 * FOUND BY REVIEW, 2026-09-06 (`docs/backlog.md`): the proxy stops the walk at the FIRST named ancestor,
 * whatever its role. An intermediate named NON-control wrapper -- a `<div aria-label="...">` unrelated to
 * the image, which a component library adds routinely -- stops it there, the role test then fails against
 * a node that was never the control the exception is asking about, and a genuinely conforming image (a
 * NAMED control sits further out) is counted as a 1.1.1 finding. **A search of 92 real pages found 19
 * candidate instances and confirmed none exhibited the shape** -- every one has `ancestorRole` `rootwebarea`
 * or `main`, meaning the walk found no named ancestor at all before the document root, so there was no
 * intermediate wrapper to stop at early. Unconfirmed, not refuted: an image that WAS correctly exempted
 * never reaches `graphicUnnamedDetail`, so the exemption's own ancestor chains were the unexamined
 * population -- which is exactly why `graphicExemptedDetail` exists now, on the exempted side.
 *
 * ONE BOUNDED WALK, not two, and not a rename: both questions read the SAME ancestor chain, so tracking
 * both trackers in one pass costs nothing extra and stopping only once BOTH are settled preserves the one
 * safety property that matters -- a malformed tree with a parent cycle cannot hang the capture. Splitting
 * this into a second function would walk the identical chain twice for every unnamed image, for no reader
 * benefit; the function still answers "what's the nearest named ancestor" as its name says, and now ALSO
 * answers the question the exception actually poses.
 *
 * `controlRole` stops at the FIRST ancestor whose role is a control, whether or not it is named --
 * deliberately not the first NAMED control further out. Nested interactive roles are not a shape this
 * exception's wording anticipates ("the content"), and an image belongs to the control it is nearest to;
 * asking whether a farther, unrelated control happens to be named would answer a different question than
 * the one the exception poses about THIS image.
 *
 * Returns the node's own role either way, so a graphic with no named ancestor and no control ancestor at
 * all is still identifiable as "an exposed unnamed image in no control", a real 1.1.1 finding.
 *
 * @param {any} node @param {Map<string, any>} byId
 */
function nearestNamedAncestor(node, byId) {
  const role = String(node?.role?.value ?? "").toLowerCase();
  // An ABSENT parentId is not a lookup key. Same reason as the map above: `String(undefined)` would find
  // whatever happened to be stored under "undefined".
  let current = node?.parentId == null ? undefined : byId.get(String(node.parentId));
  /** @type {{ ancestorName: string|null, ancestorRole: string|null, controlRole: string|null,
   *           controlName: string|null }} */
  let found = { ancestorName: null, ancestorRole: null, controlRole: null, controlName: null };
  // Bounded rather than `while (current)`: a malformed tree with a parent cycle would hang the capture,
  // and this runs inside a page evaluation with no timeout of its own.
  for (let depth = 0; current && depth < 25; depth += 1) {
    found = noteAncestor(found, current);
    // BOTH SETTLED IS THE ONLY EARLY EXIT -- stopping on `ancestorName` alone, as the old walk did, is
    // exactly the defect this rewrite fixes: a named non-control wrapper must not end the search for a
    // control further out.
    if (found.ancestorName !== null && found.controlRole !== null) break;
    current = current.parentId == null ? undefined : byId.get(String(current.parentId));
  }
  return { role, ...found };
}

/** @param {Record<string, any> | null} node */
function classifyAXNode(node) {
  // Ignored nodes are not in the tree a screen reader walks, so counting them would make the oracle demand
  // elements NVDA could never announce -- a guard that cries wolf gets removed, not heeded.
  if (!node || node.ignored) return null;
  const role = String(node.role?.value ?? "").toLowerCase();
  const named = String(node.name?.value ?? "").trim();
  const bucket = ROLE_BUCKET.get(role);
  // An unnamed `region` is NOT a landmark: ARIA requires an accessible name for `role="region"` to be
  // exposed as one, and NVDA agrees -- named regions are announced ("Latest news, region") while a bare
  // `<section>` is not. Counting them would invent landmarks the page does not have.
  if (bucket === "landmark" && role === "region" && !named) return { named, bucket: null };
  // GENERATED content is not page content, and a CSS bullet is the case that proves it. Chromium exposes a
  // `list-style-image` marker as role=image with a NEGATIVE synthetic nodeId, no properties and no
  // `backendDOMNodeId`, parented to the `<::marker>` pseudo-element. Two of those made this oracle report
  // two unnamed graphics on the W3C BAD "after" pages -- which W3C publishes as fully WCAG 2.0 AA
  // conformant -- and `addUnnamedGraphics` turns that count straight into a 1.1.1 accusation.
  //
  // Note what this was NOT: the four decorative `alt=""` images on that page were ignored by Chromium
  // correctly all along, exactly as the comment below says. 6 real images plus 2 bullets is the 8 the
  // census reported, so the count was never about the `alt=""` images at all.
  //
  // Same reasoning as the `ignored` check above: quick navigation cannot visit a bullet, so demanding the
  // sweep find one makes the oracle cry wolf. Measured over four real pages -- unnamed images fell 2 -> 0
  // on `after/home`, 2 -> 0 on `after/survey`, and stayed at ALL 33 on `before/home`, the inaccessible
  // demo, because every real `<img>` carries a `backendDOMNodeId`.
  //
  // If some future Chromium omitted that field for real elements the oracle would UNDER-count, losing a
  // possible finding rather than inventing one. For an accessibility tool that is the correct direction to
  // fail in, and it is the same tradeoff the scorer's abstention makes.
  //
  // Deliberately `bucket: null` rather than `null`: NVDA does announce generated TEXT, and the truncation
  // detector needs every name a capture can produce.
  if (isGeneratedContent(node)) return { named, bucket: null };
  return { named, bucket: bucket ?? null };
}

/**
 * Ask Chromium to bring its own window to the front, over the DevTools Protocol.
 *
 * This is the cheap answer to the phase that has cost the most: `windowsActivate` was ~10 s of a ~25 s capture
 * and did not finish at all on a heavy real website. Every other route goes outside the browser and pays for
 * it — guidepup shells out to `cscript`, which runs a WMI `Win32_Process LIKE '%msedge.exe%'` scan and a nested
 * PowerShell; a hand-rolled `SetForegroundWindow` still needs an `Add-Type` C# compile, which timed out at 15 s
 * on a loaded guest. `Page.bringToFront` asks the process that owns the window, through a socket that is
 * already how this worker drives the browser, and costs one round trip.
 *
 * It is not a complete replacement: it cannot LAUNCH a browser, and Windows can still refuse the foreground,
 * so the callers keep their fallbacks. But it is the right thing to try first, and on the path that matters —
 * a window that already exists — it is the only route that does not enumerate something.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function bringPageToFront() {
  let socket;
  try {
    const target = await pageTarget();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open", CDP_READY_TIMEOUT_MS);
    const done = waitForResult(socket, 1, CDP_READY_TIMEOUT_MS);
    socket.send(JSON.stringify({ id: 1, method: "Page.bringToFront" }));
    // A resolved round trip is the confirmation. `waitForResult` rejects on a CDP error frame, so a refusal
    // arrives here as a throw rather than as a quiet success — the distinction this project keeps having to
    // relearn about verifications that share a failure mode with the action.
    await done;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      socket?.close();
    } catch (error) {
      // A socket that will not close is not a failed activation; the request already went.
      void error;
    }
  }
}

/**
 * @param {(Record<string, any> | null)[] | null | undefined} nodes
 *   NULL ENTRIES ARE EXPECTED. `ax-census.test.ts` passes `[null, {}]` deliberately -- 'the oracle must
 *   never be the reason a capture fails' -- so a type refusing them would describe a stricter function
 *   than the one that exists, and than the one the pipeline needs.
 */
export function censusFromAXTree(nodes) {
  // `graphicUnnamed` is the count of images the page exposes with NO accessible name, and it is a finding
  // the announcements cannot reach on their own. Quick navigation skips a wholly nameless graphic: on
  // pages whose images at least have a filename NVDA says "Unlabeled graphic" and the sweep records it,
  // but for an `<img>` with no alt and a `data:` URI there is nothing to say and the sweep walks past.
  // Measured on the eval fixtures — tree 2 graphics / sweep 1, tree 1 / sweep 0, tree 3 / sweep 2 — which
  // is three 1.1.1 failures the layer could see and did not.
  //
  // Safe as a signal because of TWO guards in `classifyAXNode`, and removing either one turns this counter
  // into a false accusation. Ignored nodes are skipped, so Chromium's decorative `alt=""` images never reach
  // it; GENERATED nodes are skipped, so a CSS `list-style-image` bullet does not either -- that one was
  // found by this counter reporting two unnamed graphics on a page W3C publishes as fully AA conformant.
  // What is left is a non-ignored graphic on the page with no name: an image a screen-reader user meets and
  // cannot identify.
  // TYPED, because `names: []` infers `never[]` and every push of a real name is then an error -- and
  // the bucket increment below indexes this object by a role string. The names array is the truncation
  // detector's input, so an empty inferred type would have made the one field added for that unusable.
  // Every node by id, so an unnamed graphic can be walked back up to the control that names it. Built once
  // rather than searched per node: the tree runs to thousands on a real page.
  //
  // ABOVE the census's `@type` annotation, not between it and the `const` — putting a declaration there
  // orphans the annotation onto the wrong binding, which is the same slip made three times in one session
  // on `export-screenreader-dataset.mjs` and caught here by `tsc` rather than by reading.
  /** @type {Map<string, any>} */
  // ONLY nodes with a real id, and the omission was a live bug for an hour. `String(undefined)` is the
  // string "undefined", so every node lacking a `nodeId` collided on one key and the last one won — then
  // an image with no `parentId` looked it up and was ADOPTED by an unrelated node. In the test fixture
  // that made a nameless image the child of a named link, so the Controls/Input exception fired and the
  // count went to zero. Absent read as a value, which is this repo's oldest defect.
  const byId = new Map((nodes ?? [])
    .filter((/** @type {any} */ n) => n?.nodeId != null)
    .map((/** @type {any} */ n) => [String(n.nodeId), n]));
  /** @type {{ landmark: number, heading: number, link: number, graphic: number,
   *           graphicUnnamed: number, graphicUnnamedDetail: object[],
   *           graphicExempted: number, graphicExemptedDetail: object[], names: string[] }
   *           & Record<string, any>} */
  // EVERY BUCKET NEEDS A TOP-LEVEL COUNTER, because the loop below does `census[bucket] += 1`. Adding
  // `formControl` to ROLE_BUCKET without one made that `undefined + 1` -> NaN, which `JSON.stringify`
  // writes as `null` — so a capture reported `"formControl": null` and it read as "not measured" rather
  // than as arithmetic on an absent field. Found on the first real capture after the deploy, not by a
  // test: the tests asserted the fields they knew about, and an assertion on named fields cannot see a
  // field that was ADDED. Same lesson as `browser-args.test.ts` asserting the whole command line.
  const census = { landmark: 0, heading: 0, link: 0, graphic: 0, formControl: 0, graphicUnnamed: 0,
    graphicUnnamedDetail: [], graphicExempted: 0, graphicExemptedDetail: [], names: [],
    // DISTINCT NAMES PER TYPE, because the raw element count is not comparable with what the sweep
    // produces and the cross-check was comparing them anyway.
    //
    // `collectPhrase` DEDUPES: an announcement already seen is dropped, so `structure.links` is a list of
    // DISTINCT announcements. The census counts ELEMENTS. On real pages those are wildly different
    // quantities — measured 2026-08-29 across 106 real captures, 75% of named elements share a name with
    // another element and 100% of pages carry at least one duplicate; ico.org.uk has 15,081 duplicates
    // among 15,356 names. So the sweep read 0.24 of the element count and the cross-check called that a
    // defect on 97% of pages.
    //
    // Against DISTINCT names the ratio is 0.49 — still a real shortfall, and now a comparison of two
    // things that are supposed to be equal. Half the "97% disagreement" was definitional and half is the
    // finding; before this they were indistinguishable.
    distinct: { landmark: 0, heading: 0, link: 0, graphic: 0, formControl: 0 } };
  /** @type {Record<string, Set<string>>} */
  const seenByType = { landmark: new Set(), heading: new Set(), link: new Set(), graphic: new Set(),
    formControl: new Set() };
  for (const node of nodes ?? []) {
    const classified = classifyAXNode(node);
    if (!classified) continue;
    // Collect the name from EVERY named node, before the role bucketing, because names serve a different
    // purpose from counts. The counts are compared against specific sweeps, so they only cover the roles
    // those sweeps walk; the names exist to catch a TRUNCATED announcement and must therefore cover
    // everything a capture can announce. Restricting them to the bucketed roles left the detector unable to
    // see the case it was built for: a button announced as "o", whose real name was not in the list because
    // `button` is not a bucketed role.
    if (classified.named) census.names.push(classified.named);
    if (!classified.bucket) continue;
    census[classified.bucket] += 1;
    // An UNNAMED element has no name to be distinct from, and the sweep still announces it — so it counts
    // once per element rather than being collapsed. Treating unnamed elements as one would under-count the
    // very thing 1.1.1 and 4.1.2 are about.
    if (classified.named) seenByType[classified.bucket]?.add(classified.named);
    else if (classified.bucket in seenByType) census.distinct[classified.bucket] += 1;
    if (classified.bucket === "graphic" && !classified.named) recordUnnamedGraphic(census, node, byId);
  }
  for (const type of Object.keys(seenByType)) census.distinct[type] += seenByType[type].size;
  return census;
}

/**
 * Announcements whose name looks like a TRUNCATED version of a real accessible name.
 *
 * A proper-prefix match is the signature: "o" against "Open account search". Requiring a proper prefix
 * rather than any substring keeps this from firing on the ordinary case where NVDA announces a shortened
 * or differently-punctuated form -- it only fires when what we heard is the START of a real name and
 * stops short, which is exactly what a partial phrase looks like.
 */
/**
 * @param {string[]} spoken
 * @param {string[] | null | undefined} names
 */
export function truncatedAnnouncements(spoken, names) {
  const real = (names ?? []).map((n) => n.toLowerCase());
  const suspect = [];
  for (const phrase of spoken ?? []) {
    // The announced NAME is what precedes the role, e.g. "o, button" -> "o".
    const heard = String(phrase).split(",")[0].trim().toLowerCase();
    if (!heard) continue;
    // An exact match is fine, however short: a control genuinely named "o" is not a truncation.
    if (real.includes(heard)) continue;
    const longer = real.find((n) => n.startsWith(`${heard} `) || n.startsWith(heard) && n.length > heard.length);
    if (longer) suspect.push({ heard: String(phrase), name: longer });
  }
  return suspect;
}

/**
 * Fetch the census from the live page over the already-open DevTools socket.
 *
 * Returns null rather than throwing: this is a diagnostic, and a capture must never fail because an
 * oracle was unavailable. A null census means "not checked", which `crossCheckStructure` treats as
 * unverified rather than as agreement.
 */
export async function structuralCensus() {
  try {
    const target = await pageTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await once(socket, "open", CDP_READY_TIMEOUT_MS);
      const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
      socket.send(JSON.stringify({ id: 1, method: "Accessibility.getFullAXTree" }));
      // targetMatch travels WITH the census it describes, not beside it in a second field nobody joins --
      // the fact-stated-twice shape this repo keeps paying for. "fallback" or "no-expected-url" does not
      // make the census wrong; it makes it a claim worth reading `docs/backlog.md`'s finding over before
      // trusting on a page where NOTHING else corroborates it.
      //
      // ASSIGNED, never spread. `censusFromAXTree`'s own `@type` is an intersection with
      // `Record<string, any>` so every reader of its result -- `distinct` among them -- keeps working;
      // `{...x, targetMatch}` computes a FRESH object type from only x's NAMED properties and silently
      // drops that index signature, which turned `census.distinct` into a type error two call sites away
      // in capture-core.mjs for a census that still carries the field at runtime.
      const census = censusFromAXTree((await result)?.nodes);
      census.targetMatch = target.targetMatch;
      // Travels beside `targetMatch` for the same reason: "fallback" alone cannot say whether it was
      // forced (a real second target, unconfirmed) or vacuous (one target, so it is also the only correct
      // answer). See the typedef on `choosePageTarget`.
      census.candidates = target.candidates;
      // AND WHICH ones, because the count alone stops an investigation rather than starting it -- see
      // `choosePageTarget`. Only recorded when the choice was actually ambiguous: on the ~55 pages where
      // one target existed the urls add nothing the census does not already carry in `targetUrl`.
      if (target.candidates > 1) census.candidateUrls = target.candidateUrls;
      // WHERE the target actually was, and what was wanted — so a fallback's REASON can be READ, not
      // guessed. `evaluateOnPageTarget` already carries `targetUrl` for the identical reason; this census
      // went without it, and a fallback read as "a real second CDP target existed" even when `candidates`
      // said there was only one. See `censusTargetIsSuspect` (`@a11y-witness/evidence`) for what reads
      // these two fields.
      census.targetUrl = target.url;
      census.expectedUrl = expectedPageUrl;
      return census;
    } finally {
      try { socket.close(); } catch (error) { void error; }
    }
  } catch (error) {
    return { error: /** @type {Error} */ (error).message };
  }
}

/**
 * What the DOM contains, counted in the DOM — not in the accessibility tree.
 *
 * THE ONE MEASUREMENT THIS PROJECT DID NOT HAVE. Both existing structure sources are accessibility-layer:
 * the sweep is what NVDA reached, and `structuralCensus` is what Chromium EXPOSES. `crossCheckStructure`
 * compares those two, so it can catch a sweep that stopped early — and can say nothing whatever about
 * markup the tree never exposed.
 *
 * That gap has a cost and a name. On 2026-08-26 the Met Office warnings page captured as 27 announcements
 * with `census.heading = 0`, while its published HTML carries FORTY headings — and it was IMPOSSIBLE to
 * say whether this tool had failed to render the page or the page was failing to expose it. Those are
 * opposite verdicts: one is our defect, the other is a severe genuine finding of the kind this whole
 * project exists to make. The page had to be removed from the corpus because nobody could attribute it.
 *
 * With a DOM count beside the tree count the question answers itself:
 *
 *     dom.heading 0  tree.heading 0   the page did not render — our problem
 *     dom.heading 40 tree.heading 0   forty headings the tree cannot see — THEIR problem, and a finding
 *
 * ## What is counted, and what is deliberately not
 *
 * Only what the accessibility census also counts, so the two are comparable at all. Counting things the
 * tree has no notion of would produce a difference that means nothing.
 *
 * `alt=""` images are EXCLUDED, because Chromium marks a decorative image as ignored and the tree will
 * not count it either — including them would manufacture a permanent disagreement on correct pages. That
 * is the same reasoning `censusFromAXTree` documents for skipping ignored nodes.
 *
 * `aria-hidden` subtrees are excluded for the same reason: hidden from assistive technology by the
 * author's own instruction, so a tree that omits them is obeying, not failing.
 *
 * Returns null on any failure — this is a diagnostic and a capture must never fail because an oracle was
 * unavailable. Null reads as "not checked", never as "nothing there".
 */
/**
 * WHAT THE SERVER ACTUALLY ANSWERED -- determinism-plan D6.
 *
 * The browser's own error page is not the page under test, and this project has recorded it as evidence
 * about a site FOUR times: a gate before it shipped, two ad-hoc diagnostics, and `stability-gate`. Each
 * time the page server was not running, Edge served `ERR_CONNECTION_REFUSED`, and the capture came back
 * looking valid -- a title, a document, a readable transcript.
 *
 * A GUARD FOR THIS ALREADY EXISTED AND COULD NOT SEE IT. `BROWSER_ERROR_TITLE_RE` matches Chromium's error
 * PHRASES ("can't reach this page", "refused to connect"), but Chromium titles a network-error page with
 * the HOST -- so an unserved `http://<host>:3000/x` is titled with that bare host and matched nothing. The
 * capture read `"<host>, document, read only"` and passed. That is this repo's oldest lesson in a new
 * place: prefer the authoritative answer over an inference about behaviour. The title is a proxy for the
 * status; the status is the status.
 *
 * `responseStatus` on PerformanceNavigationTiming is the HTTP status of the MAIN document, and it is 0 when
 * there was no HTTP response at all -- which is exactly the connection-refused case. Read after the fact
 * from the page itself, so it works identically on both navigation paths: a reused window re-pointed with
 * `Page.navigate`, and a freshly launched browser given the URL on its command line. A remedy that reached
 * only the reuse path would be the shape this codebase pays for most often.
 *
 * @returns {Promise<{status: number|null, type: string|null, url: string|null, unavailable?: string}|null>}
 *   A null `status` means CDP could not answer, which is NOT a refusal -- see `assertPageWasServed`.
 *   `null` itself means the page has no navigation entry at all (`about:blank`), same treatment.
 */
export async function navigationOutcome() {
  try {
    const target = await pageTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await once(socket, "open", CDP_READY_TIMEOUT_MS);
      const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: NAVIGATION_OUTCOME_EXPRESSION, returnByValue: true },
      }));
      const value = (await result)?.result?.value;
      return value && typeof value === "object" ? value : null;
    } finally {
      try { socket.close(); } catch (error) { void error; }
    }
  } catch (error) {
    // CDP being unreachable is a different fault, reported elsewhere. Returning a status of null rather
    // than throwing keeps "the server said 404" and "we could not ask" distinguishable, which is the whole
    // point of the check -- but it must SAY which, or an unanswerable check and a clean one leave the same
    // silence. `unavailable` carries the reason into the capture's diagnostic, because a guard that stops
    // and explains nothing gets distrusted and then bypassed.
    return { status: null, type: null, url: null,
      unavailable: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `responseStatus` is Chromium 109+; `?? null` rather than a version check, so an older build reports
 * UNKNOWN instead of a misleading 0. Absence and zero are different answers here: 0 means the browser
 * tried and got no HTTP response, absence means this browser cannot say.
 */
const NAVIGATION_OUTCOME_EXPRESSION = `(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    if (!nav) return null;
    return {
      status: nav.responseStatus ?? null,
      type: nav.type ?? null,
      url: location.href,
      // WHETHER THERE IS ANYTHING TO JUDGE YET: responseStatus is 0 both when the server never
      // answered and when the response has not arrived, which are opposite conclusions. responseEnd
      // stays 0 until the response completes, so it is the only thing separating them.
      responseEnd: nav.responseEnd ?? 0,
      readyState: document.readyState,
    };
  })()`;

/**
 * The census PROGRAM, as the page will run it.
 *
 * Module-level rather than inside `domCensus` for two reasons. It is the only part of this file that
 * nothing here executes — it is a string handed to another engine — so it deserves to be findable, and
 * `dom-census-expression.test.ts` extracts it by name and runs it against a synthetic DOM, which is the
 * only check it can have. And splitting it kept `domCensus` under the line budget: the page-side program
 * and the CDP round-trip that carries it are two things, which is what the budget was telling me.
 */
const DOM_CENSUS_EXPRESSION = `(() => {
    const visible = (el) => !el.closest("[aria-hidden='true']");
    const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
    // An image with an EMPTY alt is decorative by the author's instruction; Chromium marks it ignored and
    // the AX census does not count it, so counting it here would invent a disagreement on a correct page.
    const graphics = all("img, svg[role='img'], [role='img']")
      .filter((el) => el.getAttribute("alt") !== "");
    // WHICH graphics carry no accessible name, not just how many.
    //
    // \`graphicUnnamed\` was a COUNT, and this repo's own rule is that a count is where an investigation
    // stops rather than starts. Settling whether cqc.org.uk's two unnamed graphics were real meant
    // fetching the page by hand and counting <svg> elements without a <title> — the exact step this
    // removes. Identified DOM-side because an unnamed node has, by definition, no name to identify it by.
    //
    // Presence, not resolution: an element with \`aria-labelledby\` is treated as named without following
    // the reference. Resolving it correctly is the accessibility tree's job and Chromium already did it —
    // this list exists to point a human at an element, not to second-guess the tree.
    const named = (el) => (el.getAttribute("alt") || "").trim()
      || (el.getAttribute("aria-label") || "").trim()
      || el.getAttribute("aria-labelledby")
      || (el.getAttribute("title") || "").trim()
      || (el.querySelector(":scope > title")?.textContent || "").trim();
    const describe = (el) => {
      const src = el.getAttribute("src") || "";
      const file = src ? src.split("?")[0].split("/").pop() : "";
      // Plain split, not a regex: a backslash escape inside this template literal has to be doubled
      // to survive into the page, which ESLint reads as a useless escape in the SOURCE while the page
      // would have received the right thing. Not worth the argument for a diagnostic label — class
      // tokens are space-separated and filter(Boolean) absorbs runs of them.
      //
      // NOTE FOR ANY COMMENT ADDED HERE: this is inside a template literal, so a BACKTICK ends the
      // string. The first version of this comment quoted the call in backticks and broke the file at
      // parse time, which lint reported as "Unexpected token split" ten lines from the real cause.
      const cls = (el.getAttribute("class") || "").trim().split(" ").filter(Boolean)[0];
      return [el.tagName.toLowerCase(), file, cls && \`.\${cls}\`].filter(Boolean).join(" ").slice(0, 80);
    };
    return {
      heading: all("h1, h2, h3, h4, h5, h6, [role='heading']").length,
      link: all("a[href], [role='link']").length,
      // WHICH LANGUAGES THE PAGE DECLARES, for 3.1.2 Language of Parts.
      //
      // The screen reader alone cannot decide 3.1.2 and the reason is an asymmetry: with
      // \`[speech] reportLanguage\` on, NVDA announces a language when the document language CHANGES, so an
      // announcement CONFIRMS a passage was marked — but silence is equally what a correct monolingual
      // page produces, which is almost every page on the web. A rule firing on silence would accuse every
      // English page of hiding a French one. Deciding needs the text, and the text is here.
      //
      // The DOCUMENT language and the set of OVERRIDES, separately. 3.1.1 asks whether the document
      // declares one at all; 3.1.2 asks whether passages that differ from it say so — and the second is
      // only answerable against the first.
      documentLang: (document.documentElement?.getAttribute("lang") || "").trim().toLowerCase(),
      // Capped and COUNTED, the way \`unnamedGraphics\` is: a truncated list that reads as complete is the
      // defect one layer on. Deduplicated, because a page marking forty quotations in French is one fact.
      partLangs: [...new Set(all("[lang]")
        .filter((el) => el !== document.documentElement)
        .map((el) => (el.getAttribute("lang") || "").trim().toLowerCase())
        .filter(Boolean))].slice(0, 10),
      partLangCount: all("[lang]").filter((el) => el !== document.documentElement).length,
      graphic: graphics.length,
      // Capped, and the cap SAYS so — a truncated list that reads as complete is the defect one layer on.
      unnamedGraphics: graphics.filter((el) => !named(el)).slice(0, 5).map(describe),
      unnamedGraphicCount: graphics.filter((el) => !named(el)).length,
      landmark: all("main, nav, aside, header, footer, [role='main'], [role='navigation'], "
        + "[role='banner'], [role='contentinfo'], [role='complementary']").length,
      formField: all("input:not([type='hidden']), select, textarea, [role='textbox'], "
        + "[role='combobox']").length,
      // HOW MANY TAB STOPS THE PAGE HAS, which is the only truthful denominator for "did focus reach
      // everything". 2.1.2 corroborates a trap by comparing the tab cycle against the page's controls,
      // and it had only \`structure.formFields\` to compare with — so a dialog holding every FORM FIELD
      // while links sit outside it reads as "focus reached everything" and no trap is reported.
      //
      // Counted here rather than from the sweep because the sweep announces things Tab cannot reach:
      // \`vague-link-inert\` is an anchor with \`tabindex="-1"\`, present in the corpus and walked by NVDA's
      // link quick-nav, so counting swept links would fire this rule on every page carrying one. The DOM
      // knows the difference and the sweep cannot.
      //
      // THE EXCLUSIONS ARE IN JS, NOT IN THE SELECTOR, and that is what makes them checkable. They were
      // \`:not(:disabled)\` and \`:not([tabindex='-1'])\` inside the query, which
      // \`dom-census-expression.test.ts\` cannot evaluate — its harness stubs \`querySelectorAll\` and
      // returns whatever it is handed, so the assertion about an inert anchor passed on a stub that had
      // never applied the filter. Page-side code nothing can execute is the defect that test exists for.
      //
      // \`[tabindex]\` is deliberately broad here and narrowed below: it catches a positive or zero
      // tabindex on anything, and \`-1\` is then removed. Disabled and hidden controls take no focus, and
      // reporting a control the browser skips as one focus failed to reach would be this project's oldest
      // defect — a limit of the page read as a finding about it.
      // RENDERED, not merely present. A closed mega-menu is markup a page HAS and Tab cannot reach, and a
      // denominator counting it would report a conformant page as having left most of itself unvisited —
      // the shape of every false positive this project has recorded: a limit of the measurement read as a
      // finding about the page. \`checkVisibility\` is the browser's own answer (Chromium 105+; the fleet
      // pins Edge 151), which beats reimplementing cascade rules here.
      //
      // \`inert\` is checked separately because \`checkVisibility\` does not consider it: an inert subtree
      // renders normally and takes no focus. It is exactly the modal-dialog pattern, so a 2.1.2
      // denominator that ignored it would count the very background a conformant dialog is meant to seal.
      tabbable: all("a[href], button, input:not([type='hidden']), select, textarea, [tabindex]")
        .filter((el) => el.getAttribute("tabindex") !== "-1"
          && !el.hasAttribute("hidden") && !el.hasAttribute("disabled")
          && (typeof el.checkVisibility !== "function" || el.checkVisibility())
          && (typeof el.closest !== "function" || !el.closest("[inert]"))).length,
    };
})()`;

export async function domCensus() {
  try {
    const target = await pageTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await once(socket, "open", CDP_READY_TIMEOUT_MS);
      const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: DOM_CENSUS_EXPRESSION, returnByValue: true },
      }));
      const value = (await result)?.result?.value;
      // Same reasoning as `structuralCensus`: the match status, the candidate count, and the actual vs.
      // expected URL all travel WITH the count they describe.
      return value && typeof value === "object"
        ? { ...value, targetMatch: target.targetMatch, candidates: target.candidates,
            ...(target.candidates > 1 ? { candidateUrls: target.candidateUrls } : {}),
            targetUrl: target.url, expectedUrl: expectedPageUrl }
        : null;
    } finally {
      try { socket.close(); } catch (error) { void error; }
    }
  } catch (error) {
    void error; // a diagnostic probe must never fail a capture; null reads as "not checked"
    return null;
  }
}

/**
 * The document's own title, read via CDP -- known-gaps.md §44. NVDA's spoken report of the title
 * (`reportedTitle`, capture-setup.mjs) is the LAST THING NVDA SAID, which on a page whose focus lands in a
 * live region (a search autocomplete, say) is that region's announcement, not the title -- measured on
 * `design-system.service.gov.uk/components/checkboxes/`: `titleAfter` read `"No search results"`, missing
 * the ` - Profile 1 - Microsoft Edge` browser-chrome suffix every real title carries. `document.title`
 * cannot be confused with anything else that spoke, because nothing else is being asked.
 *
 * `targetMatch`/`candidates` travel out for the identical reason `domCensus` and `evaluateOnPageTarget`'s
 * other callers already carry them -- a title read against the wrong CDP target is not evidence about the
 * page this capture was asked for, and `focusTargetIsSuspect` (capture-pure.mjs) is the one place that
 * decides "wrong target" is already answered elsewhere in this file; this does not invent a second answer.
 */
export async function documentTitle() {
  try {
    const { value, targetMatch, targetUrl, expectedUrl, candidates } = await evaluateOnPageTarget("document.title");
    return {
      title: typeof value === "string" ? value : null, targetMatch, targetUrl, expectedUrl, candidates,
    };
  } catch (error) {
    void error; // a diagnostic-grade read must never fail a capture; null reads as "not checked"
    return { title: null, targetMatch: undefined, targetUrl: undefined, expectedUrl: null, candidates: undefined };
  }
}

/**
 * Run one `Runtime.evaluate` expression against the page target, with the same open/send/close shape
 * `structuralCensus` and `domCensus` already use.
 *
 * Extracted for `installFocusEventLog`/`collectFocusEventLog`, which need TWO round trips bracketing one
 * probe rather than one -- duplicating the socket dance a third time is how the two would drift the way
 * this repo's own history warns about ("a fact stated twice"). `structuralCensus`/`domCensus` are left
 * exactly as they are: they are validated on the fleet as of this branch, and refactoring code that is
 * mid-validation to share a helper is a second, unvalidated change riding on the first one's evidence.
 *
 * `target.url` travels out alongside `targetMatch` for the same reason `targetMatch` itself exists: a
 * "fallback" tag says a match failed, never WHICH document was used instead, and a diagnostic that names
 * the tag without the URL leaves the reader unable to tell "fallback onto a widget" from "fallback onto
 * the right page anyway, for a reason `sameDocument` doesn't yet account for" -- two causes needing
 * opposite fixes, the same shape as the census's own "matched"/"fallback" ambiguity this exists to resolve.
 *
 * `expectedUrl` travels out too, read directly off this module's own state rather than through
 * `expectedPageUrlForTest` (which exists for a unit test asserting the RESET, not for a live diagnostic) —
 * so "fallback" can be read beside what it fell back FROM, not just what it fell back TO.
 *
 * `candidates` travels out too, for the identical reason `domCensus` attaches it to its own result: a
 * "fallback" `targetMatch` alone cannot tell "one page open, so fallback is the only page there was" (safe)
 * from "several pages open and this fell back rather than matching one" (worth doubting) — see
 * `censusTargetIsSuspect` (`packages/evidence/src/verify.ts`) and `focusEventVerdict`'s worker-side twin of
 * it below, which is what actually reads this field.
 *
 * @param {string} expression
 * @returns {Promise<{ value: any, targetMatch: UsablePageTarget["targetMatch"], targetUrl: string | undefined,
 *                      expectedUrl: string | null, candidates: number }>}
 */
async function evaluateOnPageTarget(expression) {
  const target = await pageTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await once(socket, "open", CDP_READY_TIMEOUT_MS);
    const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    return {
      value: (await result)?.result?.value, targetMatch: target.targetMatch, targetUrl: target.url,
      expectedUrl: expectedPageUrl, candidates: target.candidates,
    };
  } finally {
    try { socket.close(); } catch (error) { void error; }
  }
}

/**
 * Best-effort label for a focus-event log entry, computed IN THE PAGE rather than from the accessibility
 * tree -- an injected script has no CDP `Accessibility` domain access, only the DOM. Not an accessible-name
 * algorithm; a cheap approximation good enough to read back in a diagnostic, the way `nearestNamedAncestor`
 * (browser-session.mjs, 1.1.1) is a DOM-side approximation for the same reason.
 */
const FOCUS_EVENT_NAME_OF = `(el) => {
  try {
    return String((el.getAttribute && el.getAttribute("aria-label"))
      || (el.labels && el.labels[0] && el.labels[0].textContent && el.labels[0].textContent.trim())
      || (el.getAttribute && el.getAttribute("placeholder"))
      || (el.getAttribute && el.getAttribute("title"))
      || el.id || el.tagName || "unknown").slice(0, 60);
  } catch (e) { return "unknown"; }
}`;

/**
 * F55 — "using script to remove focus when focus is received" — produces a tab-stop list IDENTICAL to a
 * control that was never focusable at all: `probeFocusOrder` presses Tab, NVDA has nothing new to
 * announce (focus already moved on, or fell back to the document), and the loop either skips the control
 * silently or reads its OWN prior stop again and calls the ring a trap. Both readings are 2.1.1's
 * signature, and F55 is also — but only also — a failure of 2.4.7 (the indicator was never visible because
 * focus never RESTED) and 3.2.1 (see W3C's own listing: F55 names 2.1.1, 2.4.7, 2.4.13 AND 3.2.1 together,
 * not 2.1.1 alone). Nothing in this pipeline can currently tell "never reached" from "reached and
 * immediately expelled", and only the second is F55.
 *
 * A `focusin`/`focusout` LOG, captured at the DOM level, is the one channel that can: the browser fires
 * BOTH events on any focus change, spec-ordered, and F55's signature is `focusin(X)` followed IMMEDIATELY
 * by `focusout(X)` for the SAME element with no intervening user action — never `focusout(A)` then
 * `focusin(B)`, which is what an ORDINARY Tab press produces (A losing focus and B gaining it are the same
 * browser-level change, not two separate ones). `focusEventVerdict` (capture-pure.mjs) is the pure function
 * that tells the two apart; this only produces the raw log.
 *
 * Installed for the DURATION OF ONE PROBE, not the capture — `probeFocusOrder`, the only probe that moves
 * real focus. A listener recording nothing but push-to-array should not change anything else a capture
 * observes, but "should not" is not "shown not to": this is scoped as tightly as the evidence it exists to
 * gather allows, so that question is answerable by comparing evidence WITH and WITHOUT it on the same
 * pages, on the fleet, rather than argued from the source.
 *
 * Every element seen is assigned a per-page sequential id (a `WeakMap`, reset on install), so events can
 * be matched by IDENTITY rather than by name — two controls sharing a name must not be confused, and a
 * name is display-only here, never the join key.
 */
const INSTALL_FOCUS_EVENT_LOG_EXPRESSION = `(() => {
  if (window.__a11yFocusLog) return { already: true };
  window.__a11yFocusLog = [];
  window.__a11yFocusIds = new WeakMap();
  window.__a11yFocusNextId = 0;
  const nameOf = ${FOCUS_EVENT_NAME_OF};
  const idOf = (el) => {
    if (!window.__a11yFocusIds.has(el)) window.__a11yFocusIds.set(el, window.__a11yFocusNextId++);
    return window.__a11yFocusIds.get(el);
  };
  const start = performance.now();
  const record = (type) => (e) => {
    window.__a11yFocusLog.push({ type, id: idOf(e.target), name: nameOf(e.target),
      atMs: Math.round(performance.now() - start) });
  };
  window.__a11yFocusIn = record("focusin");
  window.__a11yFocusOut = record("focusout");
  document.addEventListener("focusin", window.__a11yFocusIn, true);
  document.addEventListener("focusout", window.__a11yFocusOut, true);
  return { installed: true };
})()`;

/**
 * @returns {Promise<{ installed: boolean, targetMatch: UsablePageTarget["targetMatch"] | null,
 *                      targetUrl: string | undefined, expectedUrl: string | null,
 *                      already?: boolean, error?: string }>}
 */
export async function installFocusEventLog() {
  try {
    const { value, targetMatch, targetUrl, expectedUrl } =
      await evaluateOnPageTarget(INSTALL_FOCUS_EVENT_LOG_EXPRESSION);
    return {
      installed: !!value?.installed || !!value?.already, targetMatch, targetUrl, expectedUrl,
      already: !!value?.already,
    };
  } catch (error) {
    // A diagnostic probe must never fail a capture. `focusEventVerdict` reads `installed: false` as
    // "cannot say", never as "F55 absent" -- absence of the oracle and absence of the finding must not
    // collapse into the same silence, the same rule `structuralCensus`'s own comment states.
    return {
      installed: false, targetMatch: null, targetUrl: undefined, expectedUrl: null,
      error: /** @type {Error} */ (error).message,
    };
  }
}

/**
 * Read the log AND remove the listeners, in one round trip -- so a capture that throws between
 * `installFocusEventLog` and here still only leaves the listeners attached for the one CDP call it takes
 * to tear them down, which `captureWithNvda`'s `finally` calls unconditionally (see its comment for why
 * that has to be unconditional: the same reasoning as `setExpectedPageUrl(null)`).
 *
 * Returns `events: null` — never `[]` — when nothing was installed to read, so "the page had no focus
 * activity" and "we never asked" cannot be mistaken for each other.
 *
 * `candidates` travels alongside `targetMatch` for the same reason `evaluateOnPageTarget` attaches it:
 * `focusEventVerdict` reads both to refuse a verdict from a log installed on the wrong document, the same
 * way `censusTargetIsSuspect` already refuses a census from one.
 *
 * @returns {Promise<{ events: Array<{type: string, id: number, name: string, atMs: number}> | null,
 *                      targetMatch: UsablePageTarget["targetMatch"] | null, targetUrl: string | undefined,
 *                      expectedUrl: string | null, candidates: number | undefined, error?: string }>}
 */
export async function collectFocusEventLog() {
  try {
    const { value, targetMatch, targetUrl, expectedUrl, candidates } = await evaluateOnPageTarget(`(() => {
      if (!window.__a11yFocusLog) return { events: null, error: "not installed" };
      const events = window.__a11yFocusLog;
      document.removeEventListener("focusin", window.__a11yFocusIn, true);
      document.removeEventListener("focusout", window.__a11yFocusOut, true);
      delete window.__a11yFocusLog; delete window.__a11yFocusIn; delete window.__a11yFocusOut;
      delete window.__a11yFocusIds; delete window.__a11yFocusNextId;
      return { events };
    })()`);
    return {
      events: value?.events ?? null, targetMatch, targetUrl, expectedUrl, candidates, error: value?.error,
    };
  } catch (error) {
    return {
      events: null, targetMatch: null, targetUrl: undefined, expectedUrl: null, candidates: undefined,
      error: /** @type {Error} */ (error).message,
    };
  }
}

/**
 * Take DOM FOCUS off whatever a PREVIOUS probe left it on, so the next Tab press starts from the FIRST
 * tabbable element rather than from wherever focus happens to be — architecture-audit.md §43.
 *
 * `probeFocusReveal` walks the tab order with Tab, and Tab moves focus RELATIVE to whatever currently
 * holds it. `anchorToTop` (Ctrl+End) resets NVDA's own quick-navigation CARET, which is a completely
 * separate piece of state from DOM focus — so a probe that ran earlier and left a form field focused (a
 * disclosure probe, a form fill) left it focused THROUGH the anchor, and every Tab after that walked from
 * THAT control rather than from the top. Measured on one real page, one URL, two capture paths: the
 * corpus path happened to leave focus on "Security question" (panel reachable in 1 Tab); the real-page
 * path left it on "Daytime telephone" (8 Tabs never reached it) — the SAME page, reported two different
 * verdicts, because of a precondition established by an earlier, unrelated probe.
 *
 * DELIBERATELY NOT THE SAME FIX AS THE CARET'S. Moving the CARET to a known position costs an element —
 * "quick navigation can never reach the element the caret is on" — which is why the anchor is `Control+End`
 * and not `Control+Home`. DOM focus has no such defect: `document.activeElement.blur()` produces the
 * identical `focusout` a real Tab-away would, and the browser's own behaviour when NOTHING is focused
 * (`document.activeElement === document.body`) is to start the NEXT Tab at the first tabbable element in
 * the document — which is the property this probe needs and cannot get from the caret anchor.
 *
 * A DIAGNOSTIC ACTION, not evidence: blurring is something THIS PROBE does to establish a known starting
 * condition, the same status `anchorToTop`/`parkPointer` already have. It runs once, before the very
 * first Tab of `walkToReveal`'s loop, so it cannot retroactively change what an EARLIER probe observed.
 *
 * **THIS `el.blur()` FIRES A REAL `focusout`, AND THAT IS THE WHOLE RISK.** `known-gaps.md` §42 moved the
 * focus-event listener install to before the capture's own first `anchorToTop()` and deleted
 * `focusLossEvidence`'s (`packages/judge/src/rules.ts`) `i === 0` exception, on the reasoning that a real
 * listener is now watching from the very start — so `log[0]` no longer needs a special case. That reasoning
 * is right about every OTHER blur on the page and wrong about THIS one: this blur is not a page behaviour,
 * it is capture-side bookkeeping (`installFocusEventListenerBeforeFirstFocus`, `capture-core.mjs`, is what
 * connects the two files, and neither names the other). An orphaned `focusout` with no matching `focusin`
 * is F55's exact signature, so without the bracket below this probe's OWN diagnostic action would be
 * reported as a WCAG 2.4.7 failure against a page that did nothing wrong -- worse than the false positives
 * §42 fixed, because it is caused by us and indistinguishable from a real one. So the listener is detached
 * immediately before the blur and reattached immediately after, INSIDE the same page-side expression --
 * an omission rather than a marker, so no future reorder of the probes or of §42's own fix can silently
 * reopen this. `focusin` is deliberately not bracketed: `blur()` alone never gives DOM focus to anything
 * (the implicit new focus target, `document.body`, does not fire `focusin`), so only `focusout` is ever at
 * risk here.
 *
 * @returns {Promise<{ blurred: boolean | null, logSuppressed: boolean, targetMatch: UsablePageTarget["targetMatch"] | null,
 *                      targetUrl: string | undefined, expectedUrl: string | null, candidates: number | undefined,
 *                      error?: string }>}
 */
export async function resetFocusToDocumentStart() {
  try {
    const { value, targetMatch, targetUrl, expectedUrl, candidates } = await evaluateOnPageTarget(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { blurred: false, logSuppressed: false };
      // Detach-blur-reattach, inside ONE page-side script so nothing between the three steps can be
      // interrupted by a separate CDP round trip. \`finally\` guarantees the reattach runs even if
      // \`blur()\` itself throws, so a probe that suppresses its own event can never leave the log
      // permanently unable to see anyone else's.
      const listener = window.__a11yFocusOut;
      if (listener) document.removeEventListener("focusout", listener, true);
      try {
        el.blur();
      } finally {
        if (listener) document.addEventListener("focusout", listener, true);
      }
      return { blurred: true, logSuppressed: !!listener };
    })()`);
    return {
      blurred: value?.blurred ?? null, logSuppressed: !!value?.logSuppressed,
      targetMatch, targetUrl, expectedUrl, candidates,
    };
  } catch (error) {
    // A failed reset is not a claim that focus is still wherever it was -- it is a claim that NOTHING is
    // known, and `focusResetOutcome` (capture-pure.mjs) reads `blurred: null` as exactly that: `applied:
    // false`, distinct from `blurred: false` ("confirmed nothing needed blurring").
    return {
      blurred: null, logSuppressed: false, targetMatch: null, targetUrl: undefined, expectedUrl: null,
      candidates: undefined, error: /** @type {Error} */ (error).message,
    };
  }
}

/**
 * What URL is the browser showing RIGHT NOW?
 *
 * Needed because a form probe on a real site can NAVIGATE. Submitting Wikipedia's search moved the browser
 * to a different page, and the post-submit field re-read then described that page instead — which
 * `validationErrorIsSilent` read as "a form was submitted and no error was announced", i.e. a 3.3.1
 * failure, on a form that had worked perfectly.
 *
 * Every synthetic page in this corpus calls `preventDefault()`, so submitting never navigated and the
 * distinction never arose. In the wild it is the ordinary case.
 *
 * Returns null rather than throwing: not knowing the URL must degrade the evidence, never fail a capture.
 */
export async function currentPageUrl() {
  try {
    return (await pageTarget()).url ?? null;
  } catch {
    return null;
  }
}

/** Resolve the reply whose `id` matches, as opposed to waitForMethod which waits for an EVENT. */
/**
 * @param {WebSocket} socket @param {number} id @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function waitForResult(socket, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP: no reply to ${id} within ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(`CDP error: ${message.error.message}`));
      else resolve(message.result);
    });
  });
}

/**
 * @param {WebSocket} socket @param {string} event @param {number} timeoutMs
 * @returns {Promise<void>}  the hint `new Promise()` needs for a `resolve()` taking no argument
 */
function once(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP: no '${event}' within ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP socket error")); }, { once: true });
  });
}

/**
 * @param {WebSocket} socket @param {string} method @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForMethod(socket, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP: no ${method} within ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // not our frame
      }
      if (parsed.method === method) { clearTimeout(timer); resolve(); }
    });
  });
}

/**
 * Launch a reusable Edge and wait until its DevTools port answers.
 *
 * @param {{ exe: string, args: string[], onEvent?: (e: object) => void }} options
 */
export async function launchReusable({ exe, args, onEvent = () => {} }) {
  if (!existsSync(exe)) throw new Error(`Edge not found at ${exe}`);
  const child = spawn(exe, args, { stdio: "ignore" });
  child.on("error", (error) => onEvent({ type: "browserError", error: error.message }));
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await browserAlive()) {
      onEvent({ type: "browserReady", pid: child.pid });
      return child;
    }
    await new Promise((r) => setTimeout(r, CDP_POLL_MS));
  }
  throw new Error(`Edge did not open its DevTools port within ${CDP_READY_TIMEOUT_MS}ms`);
}


/**
 * Media elements the page declares, for 1.4.2 Audio Control.
 *
 * The DOM, not the accessibility tree, and that is not a shortcut: `autoplay` and `muted` are HTML
 * attributes with no accessibility-tree equivalent, so no screen reader can report them. This is the only
 * evidence in the pipeline that is not something NVDA said, which its ACT description states plainly.
 *
 * Worth the one extra CDP call because 1.4.2 is a NON-INTERFERENCE criterion under WCAG §5.2.5 — it applies
 * to all content whether or not it is relied upon — and because audio that starts on its own competes with
 * the synthetic speech a screen-reader user is listening to. It masks the interface rather than merely
 * annoying.
 *
 * Returns `null` rather than throwing on total failure, and `null` means NOT CHECKED.
 *
 * **Carries `targetMatch`/`candidates`/`targetUrl`/`expectedUrl`, exactly like `structuralCensus`/
 * `domCensus` — added 2026-09-06, and the gap it closes was worse than either of those two.** This is a
 * `pageTarget()`-dependent read like both of them, and until now it was the ONE census with no way to tell
 * a confirmed page from a fallback: 1.4.2's evidence could describe whatever document a navigating probe
 * (`probeRouteChange`) had left the tab on, with nothing recorded that could ever detect it, unlike the
 * other two censuses which at least reported `fallback` and were mistrusted only by an unrelated `candidates`
 * heuristic. See `known-gaps.md` §40.
 *
 * The caller (`navigateByStructureThenAudit`) still exports `.elements` to `result.media` unconditionally —
 * this function does not decide whether the read is trustworthy, matching `structuralCensus`/`domCensus`'s
 * own split between recording (here) and judging (`censusTargetIsSuspect`, `@a11y-witness/evidence`, which
 * this worker cannot import — see `field-match.mjs`'s header for why).
 */
export async function mediaCensus() {
  const EXPRESSION = `Array.from(document.querySelectorAll("audio,video")).slice(0, 20).map((el) => ({
    tag: el.tagName.toLowerCase(),
    autoplay: el.autoplay === true,
    muted: el.muted === true || el.hasAttribute("muted"),
    controls: el.hasAttribute("controls"),
    loop: el.hasAttribute("loop"),
  }))`;
  try {
    const target = await pageTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await once(socket, "open", CDP_READY_TIMEOUT_MS);
      const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        // `returnByValue` so the result arrives as JSON rather than a remote object handle that would
        // need a second round trip to read.
        params: { expression: EXPRESSION, returnByValue: true },
      }));
      const value = (await result)?.result?.value;
      return {
        elements: Array.isArray(value) ? value : null,
        targetMatch: target.targetMatch, candidates: target.candidates,
        targetUrl: target.url, expectedUrl: expectedPageUrl,
      };
    } finally {
      try { socket.close(); } catch (error) { void error; }
    }
  } catch (error) {
    void error; // a diagnostic probe must never fail a capture; null reads as "not checked"
    return null;
  }
}
