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
import { nvda, windowsActivate, windowsQuit } from "@guidepup/guidepup";
import { focusExistingBrowserWindow } from "./window-focus.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { captureFault, FAULT } from "./capture-faults.mjs";
import { errorText } from "./error-text.mjs";
// The pure half of this module. Moved to `capture-pure.mjs` so tests can reach it without importing
// guidepup, which THROWS at import time where no screen reader exists — that is why CI was red on six
// files. Imported and re-exported here, so every existing caller of `capture-core` is unchanged and
// there is still exactly one definition of each.
import { browserArgs, browserFor } from "./browsers.mjs";
import {
  censusShape,
  crossCheckStructure,
  dedupeKey,
  elementsListRowName,
  failIfScreenReaderIsMute,
  lastMark,
  DEFAULT_BUDGET_MS,
  MIN_CONTROL_NAME_LEN,
  phraseAction,
  probeKindFor,
  readThroughDeadline,
  screenReaderWasSilentAtStart,
  sweepStepFromSpeech,
  // MOVED to capture-pure so a Linux test can reach them without guidepup (known-gaps §12,
  // second occurrence). Re-exported below, so every existing caller of this module is unchanged.
  addressesSamePage,
  focusOrderCycled,
  LANDED_BUDGET_MS,
  isBrowserErrorTitle,
  landedVerdict,
  pageServedRefusal,
  samePath,
  sweepObservation,
  notObserved,
  recordWhatWasAsked,
  focusRevealVerdict,
  censusGrowth,
} from "./capture-pure.mjs";
import { installSpeechChannelShim } from "./speech-channel.mjs";

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
 *
 * @typedef {{ out: string[], seenKeys: Set<string>,
 *             onItem?: ((phrase: string) => Promise<unknown> | unknown) | null,
 *             deadline: number, diag: Diag, label: string, trips: { count: number },
 *             observed?: Record<string, Observation>, observedAs?: string,
 *             trace?: string[] }} SweepContext
 *   What a sweep carries. `trips` is REQUIRED and that is the point: adding it to `collectByType` and
 *   spelling the context out at one call site instead of spreading it threw on the function's first line,
 *   before any sweep ran, and returned `postSubmitFields: []` on all 2,122 captures with every check
 *   green. A declared shape makes that a compile error rather than an empty field.
 */
import { parkPointer } from "./pointer.mjs";
import { matchesFieldName, matchesWithin, fillActionFor } from "./field-match.mjs";
import { browserAlive, currentPageUrl, launchReusable, navigateExisting, navigationOutcome, reusableArgs,
  mediaCensus, structuralCensus, domCensus, truncatedAnnouncements,
  bringPageToFront,
} from "./browser-session.mjs";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// --- Tunables. Named so the timing/limits can be reasoned about and adjusted
// in one place rather than hunting for bare numbers in the control flow. ---
// What the captured evidence MEANS. Bump this by hand when a change alters the shape or
// semantics of the output -- a new field that a signal reads, a probe that announces differently,
// a navigation change that reorders what is heard.
//
// Deliberately separate from the worker's code hash (`/health.code`), which changes on every edit
// including comments. The hash is right for "is this worker running my code"; it is wrong for the
// capture cache, where it would invalidate all 1,061 pairs because someone reworded a comment.
// This constant is what the cache keys on, so it must move only when the evidence really changes.
//
// Bumping it forces a full recapture. That is the point.
//
// 2 -> 3: browse mode is restored after every activation (`operateControl`). Before this, activating a
// control left NVDA in focus mode, so the quick-navigation sweeps that followed TYPED THEIR OWN LETTERS
// into the page. Measured on the corpus this bump invalidates: `links`/`graphics`/`lists` came back empty
// on 353 captures, and 125 pairs carried the typed-letter artefact on exactly ONE variant — always the
// conformant one, since only an accessible form focuses the field it rejected. That is a pair differing
// by the measuring tool, and a shortcut feature sitting in the trained scorer's input.
//
// The recapture is therefore not a cost of this change, it is the point of it: those 125 pairs are the
// ones whose evidence was wrong. `formChanges` entries also gain `kind`, and a submit now records
// `postSubmitNames`, both of which criteria read.
// 3 -> 4: speech is settled before an activation's baseline is read, and after the browse-mode Escape.
// 4 -> 5: the `list` sweep anchors to the top first, so it can find a list the caret is standing
//   inside. It reported `lists: 0` on every page whose links sit in a `<ul>` -- both directions
//   `exhausted` with empty phrases, indistinguishable from no list at all. A field that was
//   systematically empty now populates, so cached captures must not be mixed with new ones: the
//   worker's code hash is deliberately NOT in the cache key, so without this bump a revert of the
//   page sizes would silently reuse `lists: 0` evidence alongside fresh `lists: 1` evidence.
// Protocol 3's corpus carried ONE contaminated record out of ~125 activation captures —
// `filter-status-silent/bad` recorded `after: "Energy results, document"` instead of the empty delta that
// is the finding — and that single record was the false negative that made the retrained scorer fail its
// release gate. A 1-in-125 race cannot be recaptured away, so the fix is the race and the bump is what
// makes the corpus uniform afterwards.
// Protocol 5 bumped for that race and did NOT fix it. Measured again on 2026-08-17, on a bare-metal
// fleet: one capture in five of `filter-status-silent-solar/bad` recorded the same
// `after: "Energy results, document"`, and the diagnostics say why. The contaminated capture is the one
// carrying `browserRecycle` — a cold Edge start at the 25-capture boundary — while the four clean ones
// carry `browserReused`. So it was never 1-in-125 chance; it is ~1-in-25 and tied to a cadence.
//
// Protocol 5's remedy — `waitForSpeechQuiet` before the baseline — was reachable and ran. It just gave up:
// a 5 s budget against a cold browser's document announcement, returning `quiet: false` to a caller that
// discarded it, at all ten call sites. The guard could only fail one way and that way was unobservable,
// so on the slow path it degraded into the fixed sleep it had replaced.
//
// Protocol 6 raises the baseline ceiling to 20 s and CONSUMES the result. The bump is not for the new
// `baselineQuiet` field, which no signal reads yet — it is because the same page can now produce
// different evidence than it did under 5, which is the definition this file gives for a bump.
//
// Protocol 7 is capture-integrity-plan C1-C6, and the SECOND reason below is why it is a bump rather than
// an additive change.
//
// What is new: `census.distinct` (distinct NAMES per type, because the sweep dedupes announcements while
// the census counted elements — measured across 106 real pages, 75% of named elements share a name with
// another, so the two were never comparable); `formControl` in that census, counting the roles NVDA's `f`
// quick-nav actually visits; and `truncatedAnnouncements` marked UNCONDITIONALLY.
//
// FIRST, it meets this file's own criterion — "a new field a signal reads". `completeness` and
// `assertableSweep` read all three, and 2.1.1 and 4.1.2 now decline to assert on a sweep the census
// contradicts.
//
// SECOND, and this is the decisive half: WITHOUT the bump the recapture is a no-op. `workerCode` is
// deliberately not in `environmentKey` -- "it changes when a comment changes, and invalidating 1,061 pairs
// over a reworded comment is how a cache gets switched off" -- so nothing in C1-C6 moves a cache key.
// `training:capture` would serve every cached capture unchanged, the new fields would never appear,
// `completeness` would read `unknown` for ever, C2's guard would abstain on every page, and every gate
// would stay green. A cache correctly serving stale-SHAPED evidence raises no error at all. That is the
// memoised `browserVersion` again, which stamped five days of captures with a build they were not taken
// under and defeated the fleet-consistency check written for exactly that.
//
// And it meets the strict definition too: the same page now produces different evidence. A capture that
// previously carried NO truncation mark now carries one reading `{ truncated: [], checked: true }`, so
// "nothing was truncated" and "nothing checked" stop being the same silence.
//
// 7 -> 8: TWO EVIDENCE CHANGES, bundled deliberately into one bump — known-gaps §18 and §19. Each needs a
// full recapture on its own and neither is urgent, so paying once is the whole point; CLAUDE.md's rule is
// that the cheap moment for a key change is bundled with another that was happening anyway.
//
//   §18  `dedupeKey` strips EVERY container prefix, not just the first. NVDA announces every container it
//        entered, so a nested one survived and the same element keyed two ways — "main landmark, Home
//        energy, region, Home energy" and "Home energy, region, Home energy" — and `structure.landmarks`
//        reported 3 landmarks on a page with 2. Measured: 146 of 24,774 sweep announcements, in 34
//        captures, every one a `landmark-*` case; the transcript channel was clean at 0 of 35,647 because
//        `dedupeKey` is never applied to it. Verified over all 24,774: 146 keys change and NONE is reduced
//        to empty, which is the over-strip signature this would otherwise risk.
//
//   §19  an accompanying defect declares the probes its evidence needs, and
//        `withAccompanyingDefects` unions them over the host's. 69 cases carried the label
//        `1.3.1:unassociated-table` with `probeTables: false` inherited from their host, so
//        `structure.tableCells` was empty on every one. `grants-audit` passed correctly — the feature it
//        checks reads the TRANSCRIPT — and only a rule would have noticed, by finding nothing.
//
// Both are strictly evidence changes: the same page now produces different `structure` content. Neither
// is a fix to what a capture MEANS, which is why they waited for a bump rather than causing one.
// 8 -> 9, 2026-08-31: `observed` — WHAT THE CAPTURE ASKED, beside what it heard.
//
// A channel is a bare array and a bare array cannot say why it is empty. `media` has been alone in getting
// this right for the whole project, with a comment saying so. Measured over 6,467 corpus captures:
// `formChanges` empty on 4,830 with 3,006 NEVER ASKED, `postSubmitFields` 55%, and `tableCells` empty on
// 6,095 with not one where the tool could say the page has no table. Ten of the 28 model features read only
// such channels, so a `0` they treat as a page fact is usually a fact about the request.
//
// The same page can now produce different evidence than it did under 8 — a new field consumers read — which
// is the definition this file gives for a bump. It is additive, so every existing channel keeps its type and
// an older consumer ignores it; the bump is for the MEANING, not for compatibility.
// 9 -> 10, 2026-08-31, and it costs NOTHING because no corpus exists under 9.
//
// `observed` shipped with eight of its eleven channels: `sweepExtraTypes` was called without the
// accumulator, so `links`, `lists` and `graphics` could never say whether anyone asked. Threading it in is
// not a meaning change and correctly did not move the key -- which is exactly why the 46 captures already
// taken under 9 were served from CACHE, still carrying eight channels.
//
// That is the split-corpus failure the key exists to prevent, arriving through the fix rather than through
// the defect: a consumer reading `observed.links?.asked` gets a fact on some records and `undefined` on
// others, and `undefined` is the ambiguity this whole field removes. Bumping makes the corpus provably
// homogeneous for the price of 46 captures nobody has used.
// 13 -> 14, 2026-09-02: the last two screen-reader-reachable criteria, bundled for the reason 11 gives.
//
//   `interaction.focusContext`   the page title either side of FOCUSING the first control. 3.2.1 On Focus
//                                asks whether a control changes the user's context merely by receiving
//                                focus, and nothing here could ask it.
//   `typedFeedback.title*`       the same pair either side of TYPING. 3.2.2 is 3.2.1 on change rather
//                                than focus, which is how `criterion-coverage.ts` has described it since
//                                long before either was built.
//
// TAKEN TOGETHER because 11's note is explicit that a bump should carry more than one addition: each is
// individually too small to justify ~4.5 h of fleet time and taking them separately pays it twice. These
// two are the whole of what `known-gaps.md` §23 listed as remaining, so the bundle is also the end of it.
//
// The MEANING changes, which is what makes this a bump rather than an additive field: a page that renames
// itself on focus now produces evidence it could not produce before, and two captures of one page must
// never disagree about whether that question was asked. `observed.focusContext` appears on every capture
// taken from here, and `undefined` on every one before — the split the key exists to prevent.
//
// 10 -> 11, 2026-09-01: THREE additions, bundled, because the recapture is the cost and it is paid once.
//
// Bundling is the whole point of this bump rather than an economy on it. Each of the three is individually
// too small to justify ~4.5 h of fleet time, and the register says so about the first one outright; three
// together are not, and taking them separately would have cost that time three times over.
//
//   `structure.frames`          a frame sweep. An iframe with no accessible name is a real failure NVDA
//                               announces ("Radios example, frame") and this tool had no channel for --
//                               CLAUDE.md lists it under what the corpus structurally cannot express.
//   `interaction.dialogEscape`  focus, Escape, the delta, focus again. 2.1.2 asks whether a modal can be
//                               left, and nothing here could ask. Observational only: whether focus came
//                               back is a judgement about announcements and belongs to a rule.
//   `formChanges[].baselineWaitedMs`
//                               the settle MARGIN. `baselineQuiet` reads `true` on 1,117 of 1,117, so the
//                               verdict is a constant carrying no information while the margin still
//                               separates a robust wait from one record from the cliff.
//
// All three are additive and an older consumer ignores each. The bump is for the MEANING, as with 9: the
// same page now produces evidence it could not produce before, and two captures of one page must never
// differ by which build took them.
// 11 -> 12, 2026-09-01: the capture OPERATES MORE CONTROLS, so the same page yields different evidence.
//
// `probeKindFor` now returns "toggle" for a check box or radio button under `probeForms`. A live region
// updated by a checkbox was structurally unreachable before -- real filters and consent toggles are
// checkboxes far more often than buttons -- and 4.1.3 is the criterion that could not see them. The safety
// decision, and the line that draws it (can activating this NAVIGATE?), is in `SECURITY.md`.
//
// BUMPED BEFORE THE CHANGE SHIPS, not after, and that ordering is the whole point. Deploying it at 11
// would put pre-toggle and post-toggle captures under one cache key -- the split-corpus failure protocol
// 10 was spent on, arriving through a probe instead of through a memo. The constant moving here is what
// makes that impossible rather than merely unlikely.
//
// The protocol-11 corpus being captured right now is unaffected: it runs from an earlier commit and is
// internally homogeneous. It is superseded by the next capture run rather than invalidated as evidence --
// the gates it feeds still ran against real captures.
// 12 -> 13, 2026-09-01: `interaction.arrowNavigation` — the observation 2.1.1 abstains without.
//
// `SHARES_ONE_TAB_STOP` refuses to decide on a radio group, tab list or menu, because a native one and a
// broken one both present ONE tab stop and the tab ring cannot separate them. That refusal is correct and
// it leaves a criterion partly unanswered. Pressing the arrow is the only thing that can answer it.
//
// Bundled with 12 rather than deployed separately: neither has shipped, the fleet is mid-recapture, and
// two bumps against one recapture is the waste this file's own rule about bundling exists to prevent.
/**
 * What `probeTypedFeedback` types. Six digits: enough to trip a length rule, keyboard-safe, and bound by
 * no quick-navigation script. Named because it is compared against the speech log to separate NVDA's echo
 * from the page's own announcement -- a literal here and a character class there would drift apart.
 */
// How far 3.2.1 walks the tab order looking for a control that changes context on focus.
//
// Bounded because every stop costs a title read, and unbounded would make a page with a long nav bar the
// most expensive capture in the corpus. Eight is past the furniture `page()` adds — a skip link and a
// six-item list — and into the page's own controls, which is where the criterion's failure lives.
const FOCUS_CONTEXT_STOPS = 8;
// Same budget and the same reason as FOCUS_CONTEXT_STOPS: far enough past a skip link and a nav list
// to reach the page's own controls, near enough that a page revealing nothing costs eight tabs.
const FOCUS_REVEAL_STOPS = 8;

const TYPED_PROBE_TEXT = "123456";

export const CAPTURE_PROTOCOL_VERSION = 14;

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

/**
 * Installed at module load, before anything calls `nvda.start()`, so the very first connection to NVDA
 * Remote is tracked. Idempotent, so importing this module twice is harmless.
 */
const speechChannel = installSpeechChannelShim();

const DEFAULT_STEPS = 150; // read-through line count cap
const DEFAULT_BROWSER_WAIT_MS = 12_000; // UPPER BOUND on waiting for Edge, not a fixed sleep
// Deadlines for POLLS, not durations to sleep. Named as budgets so the distinction survives: every
// remaining wait in this file either checks a condition or is the interval between two such checks.
const NVDA_READY_BUDGET_MS = 3_000;   // how long a cold NVDA gets to answer at all
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

// After activating a control, how long to KEEP WAITING for an announcement that has not arrived yet.
//
// This was a flat `sleep(1200)` and it silently dropped evidence. Measured on
// disclosure-state-silent/good over 20 captures: 19 recorded the state change, 1 recorded nothing --
// so 1 in 20 captures of a CORRECTLY implemented disclosure looked exactly like the broken variant.
// That is worse than noise; it deletes the finding, and it would teach a judge that a good page is bad.
//
// Generous on purpose. An empty delta is a legitimate result -- it is precisely what the bad variant
// must produce -- so this deadline has to exceed the slowest honest announcement, or "silent" and
// "we stopped listening" become the same observation.
const STATE_WAIT_MS = 5_000;
// Once something HAS been announced, how long to wait for the rest of it. Announcements arrive in
// parts, and cutting after the first would truncate multi-phrase live regions.
const STATE_QUIET_MS = 600;
const STATE_POLL_MS = 100;

// Above the slowest honest navigation, not above a fixture's. A real site is the slow case, and being
// wrong here turns "still loading" into "wrong page" — which destroys a capture rather than costing time.


const ADVANCE_TIMEOUT_MS = 8_000; // moving to the next line/object
const READ_TIMEOUT_MS = 5_000; // reading the phrase after advancing
const NAV_TIMEOUT_MS = 6_000; // a quick-nav jump (next heading/landmark/field)
const QUERY_TIMEOUT_MS = 4_000; // reading lastSpokenPhrase / spokenPhraseLog

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
const ACT_TIMEOUT_MS = 5_000; // activating a control (Enter)

/**
 * Per-direction cap on a quick-nav sweep — sized for a REAL page, not a dataset page.
 *
 * Was 40, which is generous for the generated corpus (its largest page has 40 links by construction) and too
 * small for anything published: a real marketing page reported `link (cap)` in BOTH directions, having seen 48
 * links on a page whose initial HTML alone contains 57 `<a href>`. The tool then said "examination was
 * INCOMPLETE", which is honest but useless — a partial sweep means an absence of findings among the elements it
 * never reached is not evidence they are correct, so the page was sampled rather than validated. Validating the
 * whole page is the entire point of this product.
 *
 * The deadline, not this number, is what should end a sweep on a pathological page. This exists only so a
 * quick-nav that wraps forever cannot spin, which is why it is now far above any real element count.
 */
const MAX_SWEEP_STEPS = 250;

/**
 * How many times a silent sweep step waits for late speech before believing the page ran out.
 *
 * Three, and each wait is a speech-quiet poll rather than a fixed sleep. Bounded because a genuinely stuck
 * sweep must still end, and small because NVDA's real end-of-page answer is spoken ("no next heading") and
 * arrives on the first read — this only covers speech that was late, not speech that will never come.
 */
const SWEEP_SILENT_RETRIES = 3;

// `errorText` lives in `error-text.mjs` now, reachable by subpath so portable modules can use it without
// pulling this file — and therefore guidepup — in with it. This was a private one-liner with 35 call
// sites that nothing else could reach, so every other module narrowed a caught value by hand or not at all.
const errMsg = errorText;

// Reject if `promise` has not settled within `ms`, naming the step so a timeout
// is self-describing in the diagnostics.
const withTimeout = (/** @type {Promise<any>} */ promise, /** @type {number} */ ms, /** @type {string} */ label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

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
const reuseBrowserFor = (/** @type {{ reuseBrowser?: boolean }} */ opts) =>
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
async function openPage(url, diag, { reuse = REUSE_BROWSER, app = browserFor() } = {}) {
  navigatedExistingWindow = false;
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
async function focusBrowserWindow(maxWaitMs, diag) {
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
async function refreshBrowseBuffer(diag) {
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
async function waitForPageToSettle(diag) {
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
async function assertLandedOnRequestedPage(url, diag) {
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
async function assertPageWasServed(url, diag) {
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
async function waitForDocument(diag) {
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
async function reportedTitle(diag) {
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
async function waitForScreenReader(deadlineMs, diag) {
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
async function startScreenReader(diag, { reuse }) {
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
async function ensureSpeechChannel(diag) {
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
async function resetSpeechLogs(diag) {
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
async function recordStartupHealth(diag) {
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
async function readWithRetry({ steps, navStrategy, deadline, diag, title, silentAtStart = false }) {
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

// --- Structural navigation + interaction phase ----------------------------

// Skim the page by element type (headings, landmarks, form fields) via NVDA
// quick-nav, and — while a control is under the cursor — operate it to capture
// the announcements only interaction reveals. Returns the structure model and
// the interaction model.
/**
 * Run the sweeps, then ask Chromium how much there WAS to find.
 *
 * A sweep that under-reports reads exactly like a page with nothing on it, and until now nothing could
 * tell them apart: `structure.landmarks` misses a `<main>` wrapping the page on 2,063 of 2,064 corpus
 * captures, because quick navigation cannot reach a landmark containing the caret.
 *
 * The census is a completeness ORACLE and never evidence -- the announcements stay the evidence, and the
 * accessibility tree is barred from being a model feature. It runs on EVERY capture because it costs one
 * call on an already-open DevTools socket; asking NVDA's own Elements List for the same answer costs
 * ~11s, which is why that stays opt-in. It only ever adds a diagnostic, so no cached capture is
 * invalidated and no evidence field moves.
 */
/** @param {Record<string, any> & { diag: Diag, deadline: number }} options */
async function navigateByStructureThenAudit(options) {
  // The audit ADDS to what the structural pass produced -- `media` here, and the cross-check marks
  // below -- so the accumulator is declared rather than inferred, for the same reason as the two inside
  // `navigateByStructure`: an inferred type makes adding evidence the error and dropping it the default.
  /** @type {{ structure: CapturedStructure, interaction: CapturedInteraction,
   *           observed: Record<string, Observation>, media?: Record<string, unknown>[] | null }} */
  const result = await navigateByStructure(options);
  const census = await structuralCensus();
  // BESIDE the tree census, never instead of it. The two answer different questions — what Chromium
  // EXPOSES versus what the markup CONTAINS — and it is their disagreement that is informative:
  // `dom.heading 40, census.heading 0` is a finding about the page, `0 and 0` is a finding about us.
  // Recorded as a diagnostic so it reaches the rules without ever reaching the model.
  const dom = await domCensus();
  options.diag.mark("structureCensus", census);
  // Marked even when NULL, because "the DOM was not counted" and "the DOM has none of these" must never
  // be the same silence — the rule `refreshBrowseBuffer` cost this project a whole corpus by breaking.
  options.diag.mark("domCensus", dom ?? { error: "not counted" });
  // 1.4.2 Audio Control, from the DOM. `autoplay` and `muted` have no accessibility-tree equivalent, so
  // this is the one field here that no screen reader could have produced. Null means the probe did not
  // run, and the rule reading it makes no claim on null — a probe failure must never become a silent pass.
  // Assigned onto `result` rather than a new top-level field so it travels with the rest of the evidence.
  result.media = await mediaCensus();
  options.diag.mark("mediaCensus", { count: result.media?.length ?? null });
  // `"error" in census` rather than `!census.error`. Both are true at runtime, but only the first NARROWS
  // -- the success branch carries an index signature, so reading `.error` off it is legal and tells the
  // compiler nothing. This check is the one place that already handled the error branch correctly;
  // `waitForPageToSettle` did not, and read four absent counts as a settled page.
  if (census && !("error" in census)) {
    // A truncated announcement is not a count problem, so the count cross-check cannot see it: the sweep
    // finds the right NUMBER of controls and one of them is named "o". Only the page's real accessible
    // names can distinguish that from a control genuinely named "o".
    const truncated = truncatedAnnouncements(
      [...result.structure.formFields, ...result.structure.headings, ...result.structure.links],
      census.names,
    );
    // MARKED UNCONDITIONALLY, so "nothing was truncated" and "nothing checked it" stop being the same
    // silence. Writing the mark only when `truncated.length` made an absent mark ambiguous, and C6's
    // naming verdict read that absence as a clean bill of health — caught by `explain-capture.test.ts`,
    // which exists for exactly this shape. Same rule as `refreshBrowseBuffer` marking when it SKIPS.
    options.diag.mark("truncatedAnnouncements", { truncated, checked: true });
    options.diag.mark("structureCrossCheck", crossCheckStructure({
      sweep: {
        heading: result.structure.headings.length,
        landmark: result.structure.landmarks.length,
        link: result.structure.links.length,
        graphic: result.structure.graphics.length,
      },
      elementsList: census,
    }));
  }
  return result;
}

/**
 * Walk the page by structure and return what NVDA announced, phase by phase.
 *
 * Reads as the order the phases must run in, and that order is load-bearing rather than incidental — each
 * phase below says which cursor state it leaves behind and therefore why it cannot move.
 */

/**
 * Assemble the interaction evidence, naming every field that survives.
 *
 * Extracted because the assembly is one job with one rule, and that rule is the reason it is written out
 * longhand rather than spread: this object is REBUILT from named fields, so anything set on `interaction`
 * and not listed here is silently dropped. `postSubmitFields` was empty on all 2,122 captures for a
 * related reason, and an omission here looks exactly like a page with nothing to report.
 *
 * @param {{ structure: CapturedStructure, interaction: {stateChanges: AnnouncedChange[],
 *           formChanges: AnnouncedChange[], navigatedOnSubmit?: unknown, postSubmitNames?: string[],
 *           formFill?: unknown},
 *           postSubmitFields: string[], focusOrder: string[], routeChange: unknown, dialogEscape: unknown,
 *           arrowNavigation: unknown, typedFeedback: unknown, focusContext: unknown }} ctx
 */
function interactionEvidence({
  structure, interaction, postSubmitFields, focusOrder, routeChange, dialogEscape, arrowNavigation,
  typedFeedback, focusContext,
}) {
  return {
    controls: structure.formFields,
    stateChanges: interaction.stateChanges,
    formChanges: interaction.formChanges,
    postSubmitFields,
    focusOrder,
    // Absent unless asked for, exactly like the other opt-in evidence. Absent and "we navigated and nothing
    // was announced" must stay distinguishable: the second IS the 2.4.2 finding, and a field that is `null`
    // in both cases would make a page nobody probed look like a page that failed.
    ...(routeChange ? { routeChange } : {}),
    // Absent unless asked for, like every other opt-in field. Absent and "Escape was pressed and nothing
    // happened" must stay distinguishable: the second is the finding.
    ...(dialogEscape ? { dialogEscape } : {}),
    // Absent unless asked for. Absent and "we pressed an arrow and nothing moved" must stay
    // distinguishable: the second IS the 2.1.1 finding.
    ...(arrowNavigation ? { arrowNavigation } : {}),
    // Absent unless asked for. Absent and "we typed and the page said nothing" must stay distinguishable:
    // the second IS the 3.3.1 finding, and it is the whole reason this probe exists.
    ...(typedFeedback ? { typedFeedback } : {}),
    // Absent unless asked for. Absent and "we walked the tab order and the title never moved" must stay
    // distinguishable: the second is the CONFORMANT answer to 3.2.1, the first is no answer at all.
    ...(focusContext ? { focusContext } : {}),
    // Absent (rather than false) when the submit did not navigate, so "we did not check" and "it did not
    // navigate" stay distinguishable.
    // WHAT A CONFIGURED FORM ACTUALLY DID — filled, unbound, submitted (ADR 0024).
    //
    // Missing from this list on its first real run, and the symptom is the one this repo names most
    // often: the marks carried `filled: 1, submitted: true` while `interaction.formFill` came back NULL,
    // so the evidence existed in the debug channel and not in the channel a rule reads. `unbound` is the
    // half that matters most — a field the config named and the page did not offer may be a control with
    // no accessible name, which is the 4.1.2 finding the addressing scheme turns on, and dropping it here
    // would make a half-filled form indistinguishable from a filled one.
    ...(interaction.formFill ? { formFill: interaction.formFill } : {}),
    ...(interaction.navigatedOnSubmit ? { navigatedOnSubmit: interaction.navigatedOnSubmit } : {}),
    // Same rule, same reason: absent when no submit happened, so "no submit was probed" cannot be read as
    // "the page showed nothing after submitting". 3.3.1 depends on telling those apart.
    ...(interaction.postSubmitNames ? { postSubmitNames: interaction.postSubmitNames } : {}),
  };
}

/**
 * The two position-dependent probe groups, built as closures over one capture's accumulators.
 *
 * Extracted because they are one job -- deciding what each pass RUNS and in what order within itself --
 * and because `navigateByStructure` reads as a narrative of the phases, not of their contents. The
 * ordering inside each closure is load-bearing and commented where it bites.
 *
 * @param {any} ctx
 * @returns {{ runSweep: () => Promise<void>, runFocus: () => Promise<void>, results: any }}
 */
function probePasses(ctx) {
  const { structure, interaction, observed, onFormField, probeForms, probeTables, probeFocus,
    probeDialog, probeArrows, probeTyping, probeFocusReveal: probeFocusReveal_, deadline, diag, trips } = ctx;
  // READ from ctx, NOT destructured-and-renamed. Renaming it out of the object removed it from the
  // `...flags` that `recordWhatWasAsked` spreads, so `observed.focusContext` reported `asked: false` while
  // the probe was demonstrably running — its own diagnostic mark sat in the same capture saying
  // `focused: true`. Two records of one fact disagreeing is this repo's most-recorded defect, and the
  // rename existed only to dodge a name collision with the function.
  const probeFocusContext_ = ctx.probeFocusContext;
  /** @type {{postSubmitFields: string[], focusOrder: string[], dialogEscape: any, focusReveal: any,
   *           arrowNavigation: any, typedFeedback: any, focusContext: any}} */
  const results = {
    postSubmitFields: [], focusOrder: [], dialogEscape: null, focusReveal: null, arrowNavigation: null, typedFeedback: null,
    focusContext: null,
  };
  const runSweep = async () => {
    await sweepEveryStructuralType({ structure, onFormField, probeTables, deadline, diag, trips, observed });
    if (probeForms) diag.mark("formProbe", { activated: interaction.formChanges.length });
    results.postSubmitFields = await rescanFormFieldsAfterSubmit({ interaction, deadline, diag, trips });
  };
  // THE DIALOG PROBE RIDES WITH THE FOCUS PROBE, and it took a capture to find out why.
  //
  // It sat after the sweep first, on the reasoning that `anchorToTop` presses Escape and would dismiss
  // what the probe exists to observe. True, and beside the point: a sweep is BROWSE MODE, which moves
  // NVDA's virtual caret and never DOM focus. `keyboard-trap-modal-cycle`'s guard fires on `focusin`, so
  // it never engaged, and the probe recorded Escape pressed on the document -- IDENTICALLY on the good
  // and bad variants. A probe that cannot express the fault is worthless, and this one could not.
  //
  // `probeFocusOrder` is the only probe here that moves real focus, so it is the only one that can put the
  // caret inside a dialog for Escape to leave. Riding with it also means the pair stays together under
  // `focus-first`, where the sweep has not run at all.
  const runFocus = async () => {
    // FIRST, BEFORE `probeFocusOrder`, and this ordering is the whole correctness of the probe.
    //
    // 3.2.1 asks what happens the FIRST time a control is focused. `probeFocusOrder` walks the entire tab
    // order, so by the time it has finished, every control on the page has already been focused once — and
    // a page that renames itself on focus has already renamed itself. Measured 2026-09-02: the probe ran
    // second and read `titleBefore: "Results for the reference you typed"`, which is the CHANGED title, so
    // it compared the failure against itself and reported no change on all 28 cases.
    //
    // That is this file's rule that a probe's precondition is established by ANOTHER probe, so where it
    // sits in the sequence is part of its correctness — the same rule `anchorToTop`'s Escape and the
    // dialog probe are already here for. `probeFocusOrder` anchors to the top itself, so it is unaffected
    // by running second.
    results.focusContext = probeFocusContext_ && probeFocus
      ? await probeFocusContext({ interaction, deadline, diag })
      : null;
    // 1.4.13, and BEFORE `probeFocusOrder` for the identical reason `focusContext` above is: the reveal
    // baseline must be a census of a page nothing has focused yet. It ran after, and every one of its 18
    // cases came back BLIND -- `probeFocusOrder` walks the whole tab ring, so the panel this probe exists
    // to catch was already open when it took its "before".
    //
    // TWO PROBES HERE NOW REQUIRE A PRISTINE PAGE, and only one of them can have it. `focusContext` needs
    // an untouched TITLE and this needs an untouched CENSUS, and each walks the tab order, so whichever
    // runs second has a baseline the first may have moved. No corpus case enables both and
    // `capture-real-pages` enables neither, so this is recorded rather than solved -- but turning both on
    // for one capture makes the second one's answer unreliable, and nothing downstream would say so.
    results.focusReveal = probeFocusReveal_ && probeFocus
      ? await probeFocusReveal({ interaction, deadline, diag })
      : null;
    results.focusOrder = probeFocus
      ? await probeFocusOrder({ deadline, diag, controlsOnPage: structure.formFields.length })
      : [];
    // Gated on `probeFocus` as well as its own flag: Escape from wherever the browse caret happens to
    // rest measures the document, which is what the first version of this did.
    results.dialogEscape = probeDialog && probeFocus
      ? await probeDialogEscape({ interaction, deadline, diag })
      : null;
    // Same gate and same reason: an arrow pressed without DOM focus inside the widget navigates the
    // DOCUMENT, because browse mode owns the arrows. AFTER the dialog probe, which may have dismissed an
    // overlay -- arrows inside a widget the page has since closed measure nothing.
    results.arrowNavigation = probeArrows && probeFocus
      ? await probeArrowNavigation({ interaction, deadline, diag })
      : null;
    // LAST of the three that ride the focus probe, because it is the only one that CHANGES THE PAGE'S
    // CONTENT. Escape and an arrow leave the field as they found it; six digits do not, and a later probe
    // reading a form this one has filled in is measuring our own input.
    // LAST of the four that ride the focus probe, because it is the only one that CHANGES THE PAGE'S
    // CONTENT. Escape, an arrow and a Tab leave the field as they found it; six digits do not, and a later
    // probe reading a form this one has filled in is measuring our own input.
    results.typedFeedback = probeTyping && probeFocus
      ? await probeTypedFeedback({ interaction, deadline, diag })
      : null;
  };
  return { runSweep, runFocus, results };
}

/**
 * @param {{ deadline: number, diag: Diag, probeForms?: boolean, probeFocus?: boolean, probeTables?: boolean,
 *           probeNavigation?: boolean, probeElementsList?: boolean, probeOrder?: string,
 *           probeDialog?: boolean, probeArrows?: boolean, probeTyping?: boolean, probeFocusReveal?: boolean,
 *           probeFocusContext?: boolean,
 *           formState?: {state: string, submit: string,
 *             fields: {field: string, within?: string, nth?: number}[]},
 *           task?: string }} ctx
 */
async function navigateByStructure({ deadline, diag, probeForms, probeFocus, probeTables, probeNavigation,
  formState, probeDialog, probeArrows, probeTyping, probeFocusReveal, probeFocusContext: probeFocusContext_,
  probeElementsList, probeOrder, task }) {
  // BOTH ACCUMULATORS ARE DECLARED, because both are filled in by probes that run later and elsewhere.
  // An inferred type here describes only the fields present at construction -- `never[]` for each array,
  // and no `navigatedOnSubmit`, `postSubmitNames` or `media` at all -- so every probe that adds evidence
  // reads as an error while the one that drops evidence reads as fine. That is backwards for a file whose
  // recorded defects are `postSubmitFields` empty on all 2,122 captures and a `media` field a rule reads.
  /** @type {{ stateChanges: AnnouncedChange[], formChanges: AnnouncedChange[], sweepLog: string[],
   *           navigatedOnSubmit?: unknown, postSubmitNames?: string[], postSubmitFields?: string[] }} */
  const interaction = { stateChanges: [], formChanges: [], sweepLog: [] };
  const trips = { count: 0 };
  /** @type {CapturedStructure} */
  const structure = {
    headings: [], landmarks: [], formFields: [], graphics: [], links: [], lists: [], tableCells: [],
    frames: [],
  };
  // WHAT THIS CAPTURE ASKED, beside what it heard -- capture-protocol 9. Declared here rather than
  // inferred, for the same reason `interaction` above is: an inferred type makes adding a channel the
  // error and dropping one the default, and a dropped channel is invisible because an absent observation
  // reads exactly like an unasked one.
  /** @type {Record<string, Observation>} */
  const observed = {};
  // A CONFIGURED form REPLACES the opportunistic probe rather than running beside it.
  //
  // `operateControl` activates whatever submit-like control the sweep happens to walk past. With a
  // `formState` in hand that is actively wrong: it would press submit part-way through filling, so the
  // form would be submitted in a state the config does not describe and the evidence would be attributed
  // to a state that never existed. The configured pass fills every field first and then activates the
  // control the author NAMED.
  const onFormField = (/** @type {string} */ phrase) =>
    (formState ? Promise.resolve() : operateControl(phrase, { probeForms, deadline, interaction, task }));

  // THE TWO POSITION-DEPENDENT PROBES, SEQUENCED RATHER THAN HARD-CODED — see `probeSequence`.
  //
  // This is the pair whose order was declared LOAD-BEARING here, and `probeOrder` exists so a gate can
  // permute them and find out what that costs. `default` runs exactly what ran before, in the same order,
  // so no cached capture is affected.
  //
  // `controlsOnPage` is the sweep's own count, and it gates the confinement mark rather than the walk. Note
  // what permuting exposes: under `focus-first` the sweep has not run, so that count is 0 and the mark can
  // never say `confined`. That is temporal coupling between two probes that are supposed to be independent
  // observations, and making it visible is the point of the option.
  const { runSweep, runFocus, results } = probePasses({
    structure, interaction, observed, onFormField, probeForms, probeTables, probeFocus,
    probeDialog, probeArrows, probeTyping, probeFocusReveal, probeFocusContext: probeFocusContext_, deadline, diag, trips,
  });
  await runProbeSequence({ probeOrder, diag, runSweep, runFocus });
  // AFTER the sweep, because the sweep is what establishes where the fields are and reads them in browse
  // mode — and because filling changes the page, so a sweep afterwards would describe a document the
  // author's values had already altered.
  if (formState) await runConfiguredForm({ formState, interaction, results, deadline, diag, trips });
  // READ AFTER THE PROBES RUN, and the order is the whole of it. Destructured before `runProbeSequence`
  // -- which is where the extraction first put it -- every field binds to its INITIAL value and the
  // capture reports empty interaction evidence on every page. That is `postSubmitFields: []` on all 2,122
  // captures, reproduced exactly: an empty field is not a malformed one, no count moves, and every gate
  // stays green. Caught by reading, because `capture-core` imports guidepup and no test can reach here.
  const { postSubmitFields, focusOrder, dialogEscape, arrowNavigation, typedFeedback,
    focusContext } = results;

  // LAST of the three, because it is the only probe that can leave the page under measurement: it activates
  // a link. Everything position-dependent has finished by here, so navigating away costs nothing.
  const routeChange = probeNavigation
    ? await probeRouteChange({ interaction, deadline, diag })
    : null;
  if (probeElementsList) await crossCheckAgainstElementsList({ structure, deadline, diag });
  recordWhatWasAsked({
    // EVERY probe flag, named. This call is the one that made `observed.focusContext` say `asked: false`
    // while the probe's own mark in the same capture said `focused: true` — the flag simply was not passed.
    // The list is hand-written, which is the "six hand-written hops" shape the manifest hop was fixed for;
    // it survives here because these are the DOCUMENTED interface and a reader should see them. The guard
    // is `record-what-was-asked.test.ts` — this comment used to name a test that checks something else.
    observed, probeForms, probeFocus, probeNavigation, probeDialog, probeArrows, probeTyping, probeFocusReveal,
    probeFocusContext: probeFocusContext_, interaction,
    // NOT a probe flag, and passed for exactly that reason — see `recordWhatWasAsked`.
    formState,
  });

  return { structure, interaction: assembleAndMark({
    structure, interaction, postSubmitFields, focusOrder, routeChange, dialogEscape, arrowNavigation,
    typedFeedback, focusContext, diag,
  }), observed };
}

/**
 * Build the interaction evidence and record what it came to — one phase, and the only one after the probes.
 *
 * Extracted when `navigateByStructure` went one line over its physical-line budget. That budget is a real
 * check rather than a formality: ESLint's `max-lines-per-function` runs with `skipComments: true`, so a
 * comment-dense function here can be twice its 70-line limit and still pass — and this file is deliberately
 * comment-dense, because almost every line records a screen-reader behaviour that cost something to learn.
 *
 * It is a phase and not a name restating its code: assembling the evidence and marking what was assembled
 * belong together, and `interactionEvidence` REBUILDS the object from named fields, so the mark is the only
 * record of what survived that rebuild. `postSubmitFields: []` on all 2,122 captures is what an unmarked
 * rebuild looks like.
 *
 * @param {{ structure: CapturedStructure, interaction: any, postSubmitFields: string[],
 *           focusOrder: string[], routeChange: unknown, dialogEscape: unknown, arrowNavigation: unknown,
 *           typedFeedback: unknown, focusContext: unknown, diag: Diag }} ctx
 */
function assembleAndMark({ structure, interaction, postSubmitFields, focusOrder, routeChange, dialogEscape,
  arrowNavigation, typedFeedback, focusContext, diag }) {
  const result = interactionEvidence({
    structure, interaction, postSubmitFields, focusOrder, routeChange, dialogEscape, arrowNavigation,
    typedFeedback, focusContext,
  });
  diag.mark("interaction", {
    controls: result.controls.length,
    stateChanges: result.stateChanges.length,
    formChanges: result.formChanges.length,
    postSubmit: postSubmitFields.length,
    sweepLog: interaction.sweepLog,
  });
  return result;
}

/**
 * Submit the author's declared form, then re-read the fields — in that order, which is the whole of it.
 *
 * `rescanFormFieldsAfterSubmit` sits at the end of `runSweep`, and that is correct for the OPPORTUNISTIC
 * probe: it activates DURING the sweep, so by the sweep's end there is something to re-read. A configured
 * form is deliberately later — it fills every field first and only then presses the control the author
 * named, because pressing part-way through would attribute the evidence to a state that never existed. So
 * at the moment the sweep re-read, nothing had been submitted.
 *
 * **Fixing the re-read's `probeForms` gate alone would not have been enough**, and that is worth stating
 * because it looks like it would: the remedy would then be correct, reachable, and applied at the wrong
 * MOMENT — a fourth shape of this repo's most expensive defect, after "wrong call site", "trigger never
 * set" and "one of several paths". `postSubmitFields` would still have been `[]` on every configured
 * capture, and `build-realism` masks 4.1.3 on exactly that.
 *
 * Guarded on the field being empty, so a capture that ran BOTH paths is never re-read twice.
 *
 * @param {{ formState: any, interaction: any, results: { postSubmitFields: string[] }, deadline: number,
 *           diag: Diag, trips: { count: number } }} ctx
 */
async function runConfiguredForm({ formState, interaction, results, deadline, diag, trips }) {
  await probeConfiguredForm({ formState, interaction, deadline, diag });
  if (results.postSubmitFields.length === 0 && interaction.formChanges.length > 0) {
    results.postSubmitFields = await rescanFormFieldsAfterSubmit({ interaction, deadline, diag, trips });
  }
}

/**
 * Sweep every structural type by quick navigation, filling `structure` in place.
 *
 * ONE try/catch around all of them, deliberately: a failure part-way through keeps the types collected so far
 * and records the fault beside them. An empty field is legitimate evidence here — a page may genuinely have no
 * landmarks — so discarding the sweeps that DID work would lose real evidence to report a partial fault.
 */
/**
 * @param {{ structure: CapturedStructure, onFormField: (phrase: string) => Promise<unknown>,
 *           probeTables?: boolean, deadline: number, diag: Diag, trips: { count: number },
 *           observed: Record<string, Observation> }} ctx
 */
async function sweepEveryStructuralType({ structure, onFormField, probeTables, deadline, diag, trips, observed }) {
  const K = nvda.keyboardCommands;
  // No anchor here, deliberately. Measured: anchorToTop costs ~3s -- two nvda.press calls at
  // roughly 1.3s each plus the settle -- making it the single largest item in a 13.4s capture,
  // where all six structural sweeps together cost 1.7s.
  //
  // It is redundant by construction: collectByType sweeps BOTH directions precisely so it
  // reaches every element regardless of where the cursor starts, which is the job this anchor
  // was doing. The read-through leaves the cursor at the bottom, and the backward sweep starts
  // from there and walks up.
  //
  // If this regresses, the symptom is missing headings or landmarks on pages where the
  // read-through ended somewhere awkward -- capture-check asserts those counts on all 7 pages.
  try {
    structure.headings = await collectByType(
      { prev: K.moveToPreviousHeading, next: K.moveToNextHeading }, { label: "heading", observedAs: "headings", onItem: null, deadline, diag, trips, observed });
    // INCOMPLETE BY CONSTRUCTION, and that is not fixable here. Quick navigation cannot reach a
    // landmark containing the caret -- NVDA searches by start position and needs a separate "up"
    // direction for enclosing items -- so a `<main>` wrapping the page is invisible to this sweep.
    // 2,063 of 2,064 corpus captures whose page has a `<main>` never name it. Anchoring makes it worse
    // (Ctrl+Home is still inside such a main; it turned ["form, Hire duration"] into []), and NVDA's
    // Elements List, which does list it, costs ~11s per capture. See docs/screenreader-coverage.md.
    //
    // An empty result therefore means "nothing reachable by quick-nav", NOT "the page exposes none".
    structure.landmarks = await collectByType(
      { prev: K.moveToPreviousLandmark, next: K.moveToNextLandmark }, { label: "landmark", observedAs: "landmarks", onItem: null, deadline, diag, trips, observed });
    // Enumerate interactive controls with the form-field command ("F"), which
    // covers buttons, edits, checkboxes, combos and radios in one pass. (The NVDA
    // guide lists "F" and "B" as distinct co-equal commands; in our testing the
    // "B" button command under Guidepup missed some plain <button>s that "F"
    // reached, but that's a build-specific observation, not documented behaviour.)
    // This sweep also drives the disclosure and (opt-in) form-submit probes in place.
    structure.formFields = await collectByType(
      { prev: K.moveToPreviousFormField, next: K.moveToNextFormField }, { label: "formField", observedAs: "formFields", onItem: onFormField, deadline, diag, trips, observed });
    diag.mark("structural", { headings: structure.headings.length, landmarks: structure.landmarks.length, formFields: structure.formFields.length, roundTrips: trips.count });
    // Additive: graphics, links and lists by quick-nav, then a table walked cell by cell.
    // These fields are new, so no existing signal reads them and none can be broken by them.
    // `observed` threaded here too. Left out of this ONE call, `links`, `lists` and `graphics` were the
    // three channels with no observation at all -- and an absent observation reads exactly like an
    // unasked one, so the omission was invisible in the field built to make omissions visible. Found by
    // READING a real capture rather than by a green pipeline, which is this file's own rule.
    Object.assign(structure, await sweepExtraTypes({ deadline, diag, trips, label: "extra", observed }));
    // Table cells are OPT-IN, unlike the sweeps above, because they are not yet deterministic.
    //
    // Measured over 18 captures of one unchanged page across three workers: 4, 2, 4, 4, 1, 4, 4
    // cells and worse before the settle. The quick-nav sweeps in the same captures were rock
    // steady (graphics, links, lists, landmarks and formFields identical every time), so this is
    // specific to Ctrl+Alt+Arrow grid navigation and NVDA's speech log, not to the capture.
    // Priming into the grid, tolerating silence, and a 500 ms settle each helped and none of
    // them fixed it.
    //
    // A field that varies with timing is indistinguishable from a page that differs, which is
    // precisely the contamination this project exists to avoid -- so it stays off unless asked
    // for, and `docs/screenreader-coverage.md` says not to use it as dataset evidence yet.
    if (probeTables) {
      structure.tableCells = await probeTableCells({ deadline, diag });
      // `complete: false` AND IT IS TRUE, which is why this reverted after a moment's cleverness.
      //
      // The table probe walks a grid with Ctrl+Alt+Arrow and has no "no next heading" to exhaust, so my
      // first instinct was to omit the verdict rather than invent one. But the field does not mean "the
      // sweep exhausted", it means "an absence here can be read as the page having none" — and for this
      // channel it never can: measured over 18 captures of one unchanged page across three workers, the
      // cell count read 4, 2, 4, 4, 1, 4, 4. A probe whose output varies with timing cannot support an
      // absence claim on ANY capture, so `false` is the honest permanent answer rather than a placeholder.
      observed.tableCells = { asked: true, complete: false, stop: { prev: "n/a", next: "n/a" } };
    } else {
      // THE 100% CASE. `tableCells` is empty on 6,095 of 6,467 corpus captures and on NOT ONE of them can
      // the tool say the page has no table -- `probeTables` is opt-in, so the emptiness is about the
      // request and never about the page. Saying so is the whole point of this field.
      observed.tableCells = notObserved("probeTables is opt-in and this capture did not request it");
    }
  } catch (e) {
    diag.mark("structural", { error: errMsg(e) });
  }
}

/**
 * Re-read the form fields after a submit, so their now-persistent state reaches the evidence.
 *
 * Returns [] both when nothing was submitted and when a submit found nothing, which is correct: neither case
 * has post-submit state to judge, and `check-signals` is what decides which cases may legitimately be empty —
 * that decision needs the case definition, which this layer does not have.
 */
/**
 * @param {{ interaction: Record<string, any>, probeForms?: boolean, deadline: number,
 *           diag: Diag, trips: { count: number } }} ctx
 */
async function rescanFormFieldsAfterSubmit({ interaction, deadline, diag, trips }) {
  const K = nvda.keyboardCommands;
  // After a form was submitted in place during the sweep above, re-scan the
  // form fields to capture their now-persistent state. An accessible form marks
  // the invalid field (aria-invalid + an associated error) so it announces
  // "invalid entry"/the error whenever the cursor lands on it; an inaccessible
  // one leaves the field unchanged. This is version-robust, unlike the transient
  // live-region text in formChanges.after (which some NVDA builds don't emit).
  /** @type {string[]} */
  let postSubmitFields = [];
  // GATED ON AN ACTIVATION HAVING HAPPENED, never on `probeForms`. This is the SECOND call site of the
  // defect fixed in `recordWhatWasAsked` the same day, and finding one and not the other is this repo's
  // most expensive recurring shape -- `anchorToTop`, `ensureSpeechChannel`, `waitForAnnouncement`.
  //
  // `capture-real-pages` sends `probeForms: false` with a `formState`: the configured pass fills the
  // page owner's declared values and presses the control they named, which submits the form. With the
  // old gate this re-read simply did not run, so `postSubmitFields` was `[]` on every configured capture
  // -- and `build-realism`'s `EVIDENCE_BY_CRITERION["4.1.3"]` is `postSubmitFields.length > 0`, so the
  // criterion stayed masked and `4.1.3: 0 of 37` would not have moved. The whole point of the configured
  // form is to move it.
  if (interaction.formChanges.length > 0) {
    try {
      // Re-read the form fields' state after the submit. anchorToTop() handles
      // two NVDA facts that defeat a naive re-scan: an accessible form moves focus
      // to the invalid field (focus mode -> single-letter quick-nav is inert, so
      // Escape back to browse mode), and quick-nav skips the element the cursor
      // sits on (so Ctrl+Home anchors at the top and the sweep LANDS on each
      // field). An accessible form marks the invalid field (aria-invalid + an
      // associated error), announcing "invalid entry"/the error; an inaccessible
      // one does not. Version- and mode-robust, unlike the transient live-region
      // text in formChanges.after.
      await anchorToTop();
      // `diag` and `trips` are NOT optional, even though nothing here reads them: collectByType
      // reads `ctx.trips.count` on its first line. Omitting them threw
      // "Cannot read properties of undefined (reading 'count')" on 604 captures of one corpus --
      // before a single sweep ran, so postSubmitFields came back [] on all 2,122. The throw was
      // caught and recorded in sweepLog, which nothing reads, so `validationErrorIsSilent` spent
      // that whole corpus on the fallback its own comment calls useless and 6 cases could not
      // discriminate. Guarded now by verify.corpus.test.ts, which fails on any sweepLog ERROR.
      postSubmitFields = await collectByType(
        { prev: K.moveToPreviousFormField, next: K.moveToNextFormField },
        { label: "postSubmit", onItem: null, deadline, diag, trips });
    } catch (e) {
      // Also marked, not only logged. A probe that crashes must be visible in the evidence a
      // check can see -- sweepLog is a local record and was, on its own, indistinguishable from
      // a page that simply had nothing to announce.
      interaction.sweepLog.push(`postSubmit ERROR ${errMsg(e)}`);
      diag.mark("postSubmitFailed", { error: errMsg(e) });
    }
  }
  return postSubmitFields;
}

/**
 * Compare what the sweeps REACHED against what NVDA's Elements List says the page EXPOSES.
 *
 * Records a mark and changes no field. That is the point: the sweep's numbers stay as measured and the
 * comparison is evidence *about* them, because "quick navigation could not reach it" and "the page does not
 * have it" are different findings and correcting one with the other would erase the distinction.
 */
/** @param {{ structure: CapturedStructure, deadline: number, diag: Diag }} ctx */
async function crossCheckAgainstElementsList({ structure, deadline, diag }) {
  const authoritative = await probeElementsListCounts({ deadline, diag });
  if (!authoritative) return;
  diag.mark("structureCrossCheck", crossCheckStructure({
    sweep: {
      heading: structure.headings.length,
      landmark: structure.landmarks.length,
      formField: structure.formFields.length,
    },
    elementsList: {
      heading: authoritative.heading,
      landmark: authoritative.landmark,
      // NVDA's "Form fields" list ALREADY includes buttons -- measured: a page with one input and
      // one button reports formField=2 and button=1, the same button in both. Adding them
      // double-counted it and reported a truncation that was not there.
      formField: authoritative.formField,
    },
  }));
}

// Return NVDA to a known starting point. Per the NVDA user guide: Escape
// "switches back to browse mode if focus mode was previously switched to
// automatically" (single-letter quick-nav and caret reading are browse-mode
// features, inert in focus mode); Ctrl+Home is a standard Windows caret key that
// browse mode passes through (not an NVDA command) to move to the document top.
// Moving the caret also cancels NVDA's "Automatic say all on page load" (on by
// default), so its auto-read can't race our line-stepping.
// How long the speech log must stay UNCHANGED before NVDA counts as finished speaking, and how long we
// are willing to wait for that.
const SPEECH_QUIET_WINDOW_MS = 300;
const SPEECH_QUIET_BUDGET_MS = 5_000;
/**
 * The baseline before an activation gets a much larger ceiling than the settle sites, because it is the
 * one call where giving up CORRUPTS evidence rather than merely costing time.
 *
 * Everywhere else an early return means a slightly noisy log. Here it means the PREVIOUS step's speech
 * becomes this activation's evidence — measured on `filter-status-silent-solar/bad`, whose entire finding
 * is that activating the filter announces nothing, and which recorded `after: "Energy results, document"`
 * on the one capture of five that followed a browser recycle.
 *
 * Raising a ceiling is free. `waitForSpeechQuiet` returns as soon as the log has been unchanged for
 * SPEECH_QUIET_WINDOW_MS, so a quiet guest still leaves in ~300 ms; only the path that was silently
 * failing pays anything, and it pays instead of lying.
 */
const BASELINE_QUIET_BUDGET_MS = 20_000;

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
async function waitForSpeechQuiet(label, budgetMs = SPEECH_QUIET_BUDGET_MS) {
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

async function anchorToTop() {
  await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "esc").catch(() => undefined);
  await withTimeout(nvda.press("Control+Home"), NAV_TIMEOUT_MS, "ctrlHome").catch(() => undefined);
  await waitForSpeechQuiet("anchorSettle");
}

// Collect every element of one type, sweeping both directions (Guidepup has no
// "move to top") so every element is reached regardless of cursor position. An
// empty list means the page exposes none of that type, even if it looks like it
// does. `onItem` fires when the cursor lands on a new element.
/**
 * @param {{ prev: object, next: object }} commands
 * @param {Omit<SweepContext, "out" | "seenKeys">} ctx
 */
async function collectByType(commands, ctx) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seenKeys = new Set();
  const sweepCtx = { ...ctx, out, seenKeys };
  // Per-sweep timing and round-trip counts. `structural` is the largest remaining phase and
  // the aggregate hides which of the six sweeps costs what -- a page with one heading and no
  // landmarks still spends ~4.7s here, which points at fixed per-sweep cost rather than
  // per-element cost. Optimising without this is guesswork.
  const startedAt = Date.now();
  const before = ctx.trips.count;
  const prevOutcome = await sweepInDirection(commands.prev, sweepCtx);
  // WHERE THE BACKWARD WALK ENDED. Both directions push into one `out`, so the array is
  // reverse(everything before the caret) followed by (everything after it, in document order) -- and
  // without this index the two halves are indistinguishable and the array is NOT reading order.
  //
  // 2.4.3 compared tab order against it as though it were. Measured on check-for-flooding 2026-08-24,
  // `structure.formFields` is exactly REVERSE document order, and the rule reported a focus-order failure
  // on 25 of 35 conformant real pages. The capture already knew this and threw it away.
  //
  // Additive: `out` itself is unchanged, so every cached capture stays valid and no protocol bump is
  // needed. A capture without this mark cannot support an order claim, and `addBrokenFocusOrder` makes
  // none -- absence must not be read as "the array happens to be in order".
  const prevCount = out.length;
  const afterPrev = Date.now(), tripsPrev = ctx.trips.count - before;
  const nextOutcome = await sweepInDirection(commands.next, sweepCtx);
  ctx.diag.mark("sweep", {
    type: ctx.label,
    found: out.length,
    prevMs: afterPrev - startedAt,
    nextMs: Date.now() - afterPrev,
    prevTrips: tripsPrev,
    nextTrips: ctx.trips.count - before - tripsPrev,
    // WHY each direction stopped. Without this, an empty sweep and a truncated one are the same
    // observation -- and telling a phantom from a real element needs to know whether the sweep ran
    // out of elements, went silent, or hit the step cap.
    prevStop: prevOutcome?.stop, nextStop: nextOutcome?.stop,
    prevStopPhrase: prevOutcome?.stopPhrase, nextStopPhrase: nextOutcome?.stopPhrase,
    prevCount,
    phrases: out.slice(),
  });
  // BESIDE the mark, not instead of it. The mark goes to `diagnostics`, which is a FORBIDDEN_INPUT_KEY --
  // so the capture's own record of how it swept is classified as debugging output and cannot reach a
  // consumer. This lifts the same fact to a first-class field. A relocation, not new instrumentation.
  // Keyed by the CHANNEL it fills (`headings`), not by the sweep's diagnostic label (`heading`). The mark's
  // `type` is existing evidence and must not move: renaming it to line the two up would change every
  // capture's diagnostics to save one lookup.
  if (ctx.observed) ctx.observed[ctx.observedAs ?? ctx.label] = sweepObservation(prevOutcome, nextOutcome);
  return out;
}

/**
 * Ways back to browse mode, cheapest first, tried in order when a sweep hears its own keystroke.
 *
 * Escape is NVDA's own route out (`script_disablePassThrough`, flagged `ignoreTreeInterceptorPassThrough`
 * so it is reachable from focus mode). It is not always enough: on apache.org, whose search panel behaves
 * like an embedded document, the caret sits in a different tree interceptor and Escape reaches the page
 * rather than the mode. NVDA+Control+Space — `moveToContainingBrowseModeDocument`, "moves the focus out of
 * the current embedded object and into the document that contains it" — is the remedy for that case.
 *
 * Neither is trusted; both are tested by whether the next step still echoes.
 */
const BROWSE_MODE_REMEDIES = [
  () => withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "escapeFocusMode"),
  () => withTimeout(
    nvda.perform(nvda.keyboardCommands.moveToContainingBrowseModeDocument), NAV_TIMEOUT_MS, "leaveEmbedded"),
];

/**
 * A cheap fingerprint of THE PAGE, taken before each probe — determinism-plan D7.
 *
 * `domCensus` is sampled ONCE per capture, before every probe, so nothing can see the page move underneath
 * them. It does move: the sweep's disclosure probe ACTIVATES a control, and `gate:probe-order` measured what
 * that costs on `nls.uk/join/`:
 *
 *     default      focusOrder 10 stops   "close search, button, expanded"     <- the sweep opened it
 *     focus-first  focusOrder 150 stops  "skip to main content, link"         <- nothing had touched it
 *
 * The sweep changed the page for the next probe, and no amount of restoring NVDA's state undoes a click.
 * CLAUDE.md already knew this as an anecdote — "sportengland's search panel was expanded for the sweep and
 * collapsed for the focus probe… A capture is not an instant" — and this is what makes it checkable.
 *
 * COUNTS ONLY, and cheap on purpose: one `Runtime.evaluate` that is already written. The question is not
 * "what is on the page" but "is this the same page the last probe saw", and a changed tab-stop or control
 * count answers it. A fingerprint expensive enough to skip is one that gets skipped.
 *
 * @param {string} beforeProbe which probe is about to run
 * @param {Diag} diag
 */
async function markPageState(beforeProbe, diag) {
  const dom = await domCensus().catch(() => null);
  // Marked even when NULL. "The page was not counted" and "the page has none of these" must never be the
  // same silence — the rule that cost this project a whole corpus.
  diag.mark("pageState", { beforeProbe, ...(dom ?? { error: "not counted" }) });
}

/**
 * Run the two position-dependent probes, each from a KNOWN-GOOD STARTING POINT — determinism-plan D3.
 *
 * *Continuous Delivery*'s remedy for order-dependence, which `capture-core.mjs` used to declare as a
 * constraint to respect: steps whose order does not matter, each begun from a defined state.
 *
 * THE STATE IS ESTABLISHED BETWEEN PROBES, NOT BEFORE THE FIRST. That is why this costs nothing on the
 * default path and invalidates no cached capture: nothing runs before the first step, so there is no state
 * to restore, and the work is paid only where a probe genuinely follows another.
 *
 * Measured by `gate:probe-order` before this existed, capturing `image-missing-alt-behind-consent/good`
 * with the focus walk first:
 *
 *     headings 5 -> 0    landmarks 2 -> 0    links 6 -> 1    graphics 1 -> 0    formFields 4 -> 1
 *
 * The sweep saw ONLY the consent banner. The page — and the 1.1.1 defect that case exists to demonstrate —
 * vanished, because the focus walk left NVDA confined and in focus mode and the sweep could no longer
 * navigate. Three of three pages differed; the property this plan is built on was simply not true.
 *
 * @param {{ probeOrder: string | undefined, diag: Diag,
 *           runSweep: () => Promise<void>, runFocus: () => Promise<void> }} ctx
 */
async function runProbeSequence({ probeOrder, diag, runSweep, runFocus }) {
  const sequence = probeSequence(probeOrder);
  diag.mark("probeOrder", { order: sequence.join(","), requested: probeOrder ?? "default" });
  for (const [i, step] of sequence.entries()) {
    if (i > 0) await establishBrowseMode(diag);
    // BEFORE each probe, so two probes' evidence can be told apart from two probes' PAGES. D3 restores what
    // the screen reader carries between probes; this records what the PAGE carried, which D3 cannot fix
    // because a disclosure the sweep opened cannot be un-opened.
    await markPageState(step, diag);
    await (step === "sweep" ? runSweep() : runFocus());
  }
}

/**
 * Put NVDA back in browse mode before the next probe reads the page — a PRECONDITION, not a recovery.
 *
 * `BROWSE_MODE_REMEDIES` already existed and is reused rather than respelled, but it was applied REACTIVELY:
 * "tried in order when a sweep hears its own keystroke". That needs the sweep to hear something it can
 * recognise as an echo, and `gate:probe-order` measured the case where it hears nothing at all — headings
 * 5 -> 0, links 6 -> 0, graphics 1 -> 0. A sweep that finds NOTHING has no phrase to detect an echo from,
 * and "this page has no headings" and "we could not ask" become the same evidence, which is the one thing
 * this project's capture layer may never allow.
 *
 * BOTH RUNGS, unconditionally, because neither is trusted and there is nothing to test them against here.
 * Escape is NVDA's own route out; `moveToContainingBrowseModeDocument` is the remedy for a caret sitting in
 * a separate tree interceptor, which is what a dialog produces. The reactive path tests each by whether the
 * next step still echoes; a precondition has no next step yet, so it applies the ladder and MARKS it.
 *
 * Marked whether or not it changed anything, because "did not need to" and "never ran" are otherwise the
 * same silence — `refreshBrowseBuffer` guarded on a flag nothing ever set and returned early on every
 * capture ever taken, while three `capture:check` runs passed and would have vouched for it.
 *
 * @param {Diag} diag
 */
async function establishBrowseMode(diag) {
  for (const remedy of BROWSE_MODE_REMEDIES) await remedy().catch(() => undefined);
  // AND THE CARET, because a known state is a MODE AND A POSITION — but the position has to be the one the
  // PIPELINE ALREADY ESTABLISHES, not one chosen by intuition. `Control+Home` was tried first and made
  // things WORSE, which is what identified the real rule.
  //
  // QUICK NAVIGATION CAN NEVER REACH THE ELEMENT THE CARET OCCUPIES, in either direction. So every caret
  // position costs exactly one element of whatever type sits under it, and the only safe position is one
  // that is not an element of any swept type. Measured:
  //
  //   Control+Home   caret lands on the h1 (document start IS the h1) -> h1 lost on ALL THREE pages,
  //                  including one that had been agreeing
  //   default order  caret sits at the BOTTOM after the read-through -> the backward sweep reaches the h1
  //                  from below, and nothing is lost
  //
  // The default order does not work by design here; it works because the read-through leaves the caret past
  // the last heading. `readWithRetry` runs before every probe, and the sweep's own comment states the
  // convention: "The read-through leaves the cursor at the bottom, and the backward sweep starts from there
  // and walks up." So the known-good position is THE END, and restoring it makes both orders converge on
  // the state the pipeline already had rather than on a new one.
  await withTimeout(nvda.press("Control+End"), NAV_TIMEOUT_MS, "anchorCaret").catch(() => undefined);
  await waitForSpeechQuiet("browseModeSettle");
  diag.mark("establishBrowseMode", { applied: BROWSE_MODE_REMEDIES.length + 1, caretAnchored: true });
}

/**
 * Record one announcement, unless this sweep has already seen it.
 *
 * De-duplication is by announcement, so two elements announced identically collapse to one entry. That is the
 * right behaviour for evidence — the same phrase twice is not two findings — but it means the collected COUNT
 * is distinct announcements rather than elements reached, which is why the coverage report says so explicitly.
 */
/**
 * @param {string} phrase
 * @param {Pick<SweepContext, "out" | "seenKeys" | "onItem">} ctx
 */
async function collectPhrase(phrase, { out, seenKeys, onItem }) {
  const key = dedupeKey(phrase);
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  out.push(phrase);
  if (onItem) await onItem(phrase);
}

/**
 * Try the next remedy for a stuck focus mode. Returns false when they are exhausted.
 *
 * Extracted alongside `awaitLateSpeech` because `sweepInDirection` had grown past three separate budgets —
 * complexity, nesting depth and the 90-physical-line limit — and both blocks are "what we do when a step goes
 * wrong", which is a different level of abstraction from walking the page. The reasoning stays at the call site
 * where the symptom is visible.
 */
/** @param {number} attempt */
async function applyBrowseModeRemedy(attempt) {
  if (attempt > BROWSE_MODE_REMEDIES.length) return false;
  await BROWSE_MODE_REMEDIES[attempt - 1]().catch(() => undefined);
  return true;
}

/**
 * A sweep step said nothing. Wait for late speech and re-read, rather than pressing again.
 *
 * LATE SPEECH IS NOT THE END OF THE PAGE. `silent` meant "no new speech, therefore the cursor did not move",
 * and the sweep returned on it immediately. That is sound on an idle guest and wrong on a busy one: NVDA's
 * speech can arrive after the poll, and the cost is a silently truncated sweep. Measured on a real page,
 * headings came back 3 when the accessibility tree held 10, with `nextStop: silent` — evidence lost with no
 * error anywhere, which is the failure this project forbids above all others.
 *
 * The decisive argument for retrying is that NVDA ANNOUNCES the real end of the page: a quick-nav with nowhere
 * to go says "no next heading", which the `exhausted` branch catches. Silence is therefore not the normal
 * terminus at all, so treating it as one resolves an ambiguity the wrong way — the same mistake as stopping on
 * a single repeated phrase, made with a different signal.
 *
 * Re-READS at the same log offset; it never re-issues the navigation command. Pressing again would advance the
 * cursor, so a step whose speech was merely late would SKIP an element — a hole in the middle of a sweep, which
 * is worse than a short one because nothing reports it.
 *
 * ONE JSDoc BLOCK. This was briefly two adjacent ones, and only the last attaches -- so the `@returns`
 * silently did not apply and the caller went back to reading an inferred union on which no field was safe.
 * A second block is not an error anywhere; it is simply ignored.
 *
 * @param {{ step: import("./capture-pure.mjs").SweepStep, prev: string, repeats: number,
 *           label: string, trips: { count: number } }} state
 * @returns {Promise<import("./capture-pure.mjs").SweepStep>}
 *   the recovered step, or a step carrying a `stop` if speech never arrived
 */
async function awaitLateSpeech({ step, prev, repeats, label, trips }) {
  for (let retry = 0; retry < SWEEP_SILENT_RETRIES; retry += 1) {
    await waitForSpeechQuiet(`${label}SilentRetry`);
    trips.count += 1;
    const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label).catch(() => [])) || [];
    const again = sweepStepFromSpeech({ log, seen: step.seen, prev, repeats });
    // Anything other than silence is a real answer — "no next heading", a channel reset — and belongs to the
    // caller unchanged. Only continued silence is worth another wait.
    if (again.stop !== "silent") return again;
  }
  return { stop: "silent", seen: step.seen, silentRetries: SWEEP_SILENT_RETRIES };
}

/**
 * @param {object} cmd
 * @param {SweepContext} ctx
 */
async function sweepInDirection(cmd, { label, out, seenKeys, onItem, deadline, trips }) {
  // Movement is decided by "did NVDA say anything NEW?", never by "did lastSpokenPhrase change?".
  //
  // The old test was unsound in the one case that matters. When a quick-nav jump does not move and
  // NVDA says nothing at all, `lastSpokenPhrase` keeps returning an OLDER phrase -- and because that
  // phrase was compared against a seed carried over from the previous sweep, it differed, passed
  // every guard, and was recorded as an element that does not exist. That produced a phantom
  // landmark on a page where NVDA's own Elements List reports "1 of 1", and the phantom changed the
  // evidence text enough to flip a conformant page's score across a threshold.
  //
  // A log delta cannot be fooled by history: a stale phrase is, by definition, not in it. Note the
  // asymmetry that makes this the right test -- silence is unambiguous evidence of not moving, while
  // an unchanged phrase is ambiguous between "did not move" and "moved to something announced the
  // same way".
  //
  // `prev` still guards genuine repetition, but starts EMPTY: seeding it across sweeps is what made
  // a stale phrase look like news.
  let prev = "";
  // Threaded through so the repeat threshold is CONSECUTIVE. Resetting it on every step would make three-in-a-
  // row unreachable and restore the one-repeat behaviour this replaced.
  let repeats = 0;
  let recoveries = 0;
  // Read once, then advance as we go, so this costs the same two round trips per step as the
  // lastSpokenPhrase version it replaces. `trips` therefore stays comparable across the change.
  trips.count += 1;
  let seen = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label).catch(() => [])) || []).length;
  for (let i = 0; i < MAX_SWEEP_STEPS; i++) {
    // Running out of budget and finding nothing more are DIFFERENT observations, and both used to
    // fall through to `stop: "cap"` below -- so a sweep that never got to ask reported the same
    // reason as one that walked the whole page. Measured on a rescaled page (40 links, 40 list
    // items): links came back 27/34/33/26 and lists came back 0 four times out of four, with zero
    // worker faults. A `lists: 0` that actually means "the budget was already spent by the links
    // sweep" is the conflation this project forbids -- absence must never be reported as a finding.
    if (Date.now() > deadline) return { stop: "deadline", steps: i, stopPhrase: prev };
    // Declared: written in a `try` and again in a conditional, so inference gives up across both.
    /** @type {import("./capture-pure.mjs").SweepStep} */
    let step;
    try {
      trips.count += 2;
      await withTimeout(nvda.perform(/** @type {any} */ (cmd)), NAV_TIMEOUT_MS, label);
      const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label)) || [];
      step = sweepStepFromSpeech({ log, seen, prev, repeats });
    } catch (error) {
      // Same asymmetry: a round trip that threw is not evidence the page ran out of elements.
      return { stop: "error", steps: i, stopPhrase: prev,
        error: String(/** @type {Error} */ (error)?.message ?? error) };
    }
    seen = step.seen;
    repeats = step.repeats ?? 0;
    // Late speech is not the end of the page — see `awaitLateSpeech`.
    if (step.stop === "silent") {
      const settled = await awaitLateSpeech({ step, prev, repeats, label, trips });
      if (settled.stop) return { ...settled, steps: i, stopPhrase: prev };
      seen = settled.seen;
      repeats = settled.repeats ?? 0;
      step = settled;
    }
    // `prev` is the phrase that ENDED the sweep, and naming it is what makes a leak legible. A sweep
    // reporting `found=0 stop=repeat` says only "nothing"; the same sweep reporting `stopPhrase: "k"` says
    // NVDA was in focus mode and this pipeline typed its own quick-navigation key into the page. That
    // distinction went unmade for 2,122 captures.
    // A `const` alias so `SweepStep`'s discrimination survives the reassignments above.
    const settledStep = step;
    if (settledStep.stop) return { stop: settledStep.stop, steps: i, stopPhrase: prev };
    const phrase = settledStep.phrase;
    prev = phrase;
    // A one- or two-character phrase is NVDA echoing the key we just sent, which is proof that the key
    // went to the page instead of to NVDA -- focus mode. This used to `continue` past it in silence, and
    // that silence is what let this pipeline type its quick-navigation keys into 2,122 captures' pages.
    //
    // Recover rather than assume: each remedy is tried and then TESTED by the next step's phrase, because
    // pressing Escape and hoping is what left apache.org still echoing after the post-activation Escape
    // was added. Escalates once, then gives up loudly -- `focusModeStuck` is the difference between "this
    // page has no links" and "we could not ask".
    if (phrase.length < MIN_CONTROL_NAME_LEN) {
      recoveries += 1;
      if (!(await applyBrowseModeRemedy(recoveries))) {
        return { stop: "focusModeStuck", steps: i, stopPhrase: phrase };
      }
      prev = ""; // the echo is not evidence of position, so it must not count as a repeat
      continue;
    }
    await collectPhrase(phrase, { out, seenKeys, onItem });
  }
  return { stop: "cap", steps: MAX_SWEEP_STEPS };
}

// Element types a screen-reader user quick-navigates by, beyond the three we already sweep.
// Each one was previously evidence we got only by ACCIDENT -- if the line-by-line read-through
// happened to pass over the element -- which is not the same as having looked:
//
//   graphic  "graphic, Ada Lovelace portrait" vs a bare "graphic". This is 1.1.1, and it is
//            what the image-missing-alt / generic-alt / filename-alt cases are about; they were
//            being judged on whatever the read-through picked up.
//   link     link text OUT OF CONTEXT, which is precisely what 2.4.4/2.4.9 asks about and what
//            a real user sees in NVDA's elements list. "read more" is only a failure when
//            isolated from its paragraph -- so isolating it is the test.
//   list     "list with 4 items" and nesting depth: 1.3.1.
//
// Cheap enough to be on by default: the three existing sweeps cost 1.7s for six directions,
// so each direction is ~0.28s.
const EXTRA_SWEEPS = [
  { key: "graphics", label: "graphic", prev: "moveToPreviousGraphic", next: "moveToNextGraphic" },
  { key: "links", label: "link", prev: "moveToPreviousLink", next: "moveToNextLink" },
  // `anchorFirst` because a list CONTAINS the things swept before it, and quick-nav cannot find the
  // container the caret is standing inside. Measured: a page with one `<ul>` of six links reported
  // `lists: 0` with BOTH directions `exhausted` and both stop phrases empty -- the exact signature of a
  // type that is absent, on a page where it is present. The link sweep ends on the last link, which is
  // inside that `<ul>`, so "previous list" finds none before it and "next list" finds none after it.
  //
  // This is the cost of `9cabfb4`'s "removed a redundant anchor: 15.8s -> 13.4s". The anchor was not
  // redundant -- it was load-bearing for any sweep whose elements nest around an earlier sweep's. Only
  // this one needs it, so the ~3s is paid once rather than before all six.
  { key: "lists", label: "list", prev: "moveToPreviousList", next: "moveToNextList", anchorFirst: true },
  // FRAMES. An embedded document with no accessible name is a dead end a user cannot label, and until now
  // this tool could not see one at all -- `docs/screenreader-coverage.md` listed it as a gap and noted the
  // corpus has no iframe either, so it was invisible to every gate as well as to every capture.
  //
  // `anchorFirst` for the reason the `lists` comment gives above, applied one container further out: a
  // frame CONTAINS the things swept before it, and quick navigation cannot find the container the caret is
  // standing inside. The link and list sweeps both end somewhere that may be inside a frame, so without
  // the anchor "next frame" finds none after it and "previous frame" none before it -- the exact signature
  // of a page with no frames, on a page that has one. It costs ~3s, which is the same ~3s `lists` pays and
  // for the same reason.
  { key: "frames", label: "frame", prev: "moveToPreviousFrame", next: "moveToNextFrame", anchorFirst: true },
];

/** @param {Omit<SweepContext, "out" | "seenKeys">} ctx */
async function sweepExtraTypes(ctx) {
  // Indexed by the sweep's own key names, which is what `EXTRA_SWEEPS` holds -- guidepup types
  // `keyboardCommands` as a 160-key literal, so a dynamic lookup needs to say it is one.
  const K = /** @type {Record<string, any>} */ (nvda.keyboardCommands);
  /** @type {Record<string, string[]>} */
  const found = {};
  for (const { key, label, prev, next, anchorFirst } of EXTRA_SWEEPS) {
    // See EXTRA_SWEEPS: only a sweep whose elements can CONTAIN an earlier sweep's pays for the anchor.
    if (anchorFirst) await anchorToTop();
    found[key] = await collectByType({ prev: K[prev], next: K[next] },
      { ...ctx, label, observedAs: key, onItem: null });
  }
  return found;
}

// How far to walk a table. Enough to cross a header row and enter the data below it, which is
// where header association shows up; not so far that a wide table dominates the capture.
const MAX_TABLE_STEPS = 6;

// Table navigation must not read the speech log until NVDA has finished talking. Without that wait,
// nine captures of the SAME page returned 4, 4, 1, 4, 2, 3, 0 and one error's worth of cells --
// evidence that varied purely with timing, which is indistinguishable from a page that differs.
// Quick-nav sweeps tolerate less waiting because each jump is slower; a Ctrl+Alt+Arrow inside an
// already-rendered grid returns faster than NVDA updates its log. This used to be a fixed 500ms;
// `waitForSpeechQuiet` waits for the actual condition, which matters most in the tail where a fixed
// wait expires early and a truncated walk is recorded as a page with fewer cells.

// NVDA's own words for "there is no cell here". Shared, because only walkTable checked for them and
// enterFirstCell did not -- so a table walked from its caption recorded "Edge of table" AS A CELL and
// the evidence contained a boundary message dressed up as content. Measured: tableCells[1] was
// "Edge of table" on a 2x3 table.
const TABLE_BOUNDARY = /\bedge of table\b|\bnot in a table\b/i;

// One dud step is tolerated before giving up. Guidepup's own description is "WHEN WITHIN A
// TABLE, moves the system caret to the next column" -- and jumping to a table with T lands on
// its caption, which is not within the grid. So the first Ctrl+Alt+Arrow announces nothing and
// a walk that stopped at the first unchanged phrase collected only the table's entry line.
// Measured: tableCells was 1 on a 2x3 table before this.
// Three, not two, because silence now counts as a miss and a slow speech log can swallow one
// step without the walk being over.
const MAX_TABLE_MISSES = 3;

// What NVDA said in response to one keystroke, as a DELTA of the spoken-phrase log.
//
// This replaces reading lastSpokenPhrase, and it is the fix for the defect that made tableCells
// unusable: 18 captures of one unchanged page returned 4, 2, 4, 4, 1, 4, 4 cells. "What was last
// said" is a single sample of a moving target -- if the announcement had not landed yet the read
// returned the PREVIOUS phrase (indistinguishable from "did not move") or nothing (which the walk
// took for the end of the table). Priming, silence tolerance and a 500 ms settle each helped and
// none of them fixed it, because all three were compensating for the wrong read.
//
// A delta cannot miss a late announcement: whatever arrived during the settle is in the log, and
// an empty delta means NVDA genuinely said nothing. Same idiom as activateAndCaptureDelta, which
// exists because a live-region status can be followed by a focus move that overwrites
// lastSpokenPhrase.
/** @param {() => Promise<unknown>} step @param {string} label */
async function speechDelta(step, label) {
  const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label).catch(() => [])) || []).length;
  await withTimeout(step(), NAV_TIMEOUT_MS, label);
  // `waitForAnnouncement`, NOT `waitForSpeechQuiet`, and the difference cost a table cell.
  //
  // `waitForSpeechQuiet` waits for the log to stop CHANGING. Here speech has usually not started yet --
  // a Ctrl+Alt+Arrow inside an already-rendered grid returns faster than NVDA updates its log -- so an
  // unchanged log satisfied "quiet" immediately, the delta came back empty, and the walk read that as a
  // missing cell. `evidence:check` caught it as `tableCells: 5 -> 4` on both variants of
  // `table-unassociated-headers`; a condition has to be SUFFICIENT, not merely true.
  //
  // `waitForAnnouncement` waits for the log to GROW first, treats never growing as a genuine silence
  // (which is a finding here, not a failure), and only then waits for it to settle.
  const log = await waitForAnnouncement(before, label);
  // Joined rather than reduced to one entry: a cell whose announcement arrives as two utterances
  // is still one cell, and dropping either half would be losing evidence.
  return log.slice(before).map((/** @type {unknown} */ phrase) => String(phrase).trim()).filter(Boolean).join(", ");
}

// Walk one direction inside a table, appending each newly announced cell.
/**
 * @param {() => Promise<unknown>} step
 * @param {{ out: string[], deadline: number, label: string, trace: string[] }} ctx
 */
async function walkTable(step, { out, deadline, label, trace }) {
  let misses = 0;
  for (let i = 0; i < MAX_TABLE_STEPS; i += 1) {
    if (Date.now() > deadline) break;
    let phrase;
    try {
      phrase = await speechDelta(step, label);
    } catch (e) { trace.push(`${label} threw ${errMsg(e)}`); break; }
    trace.push(`${label}[${i}] ${phrase.slice(0, 60) || "(silence)"}`);
    // Only NVDA's own boundary wording ends the walk.
    if (TABLE_BOUNDARY.test(phrase)) break;
    // Silence is still retried rather than treated as the end -- but with a delta it now means
    // NVDA really said nothing, not that the read was early. There is no "unchanged phrase" case
    // any more: a delta is new speech by construction.
    if (!phrase) {
      misses += 1;
      if (misses >= MAX_TABLE_MISSES) break;
      continue;
    }
    misses = 0;
    if (!out.includes(phrase)) out.push(phrase);
  }
}

// Navigate a table CELL BY CELL, which is the only way to see whether headers are associated.
//
// A properly marked-up table announces the header as you enter each cell -- "Price, £4.99" --
// while a layout table or one with unassociated <td> headers gives you coordinates only:
// "row 3, column 2, £4.99". The dataset already has a POSITION_ONLY_CELL signal looking for
// exactly that, but nothing was ever driving the cell navigation that produces it: the
// row/column text in existing captures is incidental, from the read-through crossing a table.
//
// Both directions are tried before giving up, because the cursor sits at the END of the
// document after the structural sweeps -- "next table" from there finds nothing on a page
// whose only table is above. Cheaper than a ~3s anchorToTop.
/** @param {{ deadline: number, diag: Diag }} ctx */
async function probeTableCells({ deadline, diag }) {
  const K = nvda.keyboardCommands;
  const cells = [];
  /** @type {string[]} */
  const trace = [];
  let note = null;
  try {
    const entry = await enterFirstTable(K);
    if (!entry) note = "no table on the page";
    else {
      cells.push(entry);
      const first = await enterFirstCell(K, { trace });
      if (!first) note = "table found but no navigable cell";
      else {
        cells.push(first);
        await walkTable(() => nvda.perform(K.moveToNextColumn), { out: cells, deadline, label: "col", trace });
        await walkTable(() => nvda.perform(K.moveToNextRow), { out: cells, deadline, label: "row", trace });
      }
    }
  } catch (e) {
    note = errMsg(e);
  }
  diag.mark("tableCells", { found: cells.length, note, trace });
  return cells;
}

// Get the caret INTO the grid.
//
// Jumping to a table with T lands on its <caption>, which is inside the table element but
// outside the grid, and NVDA answers every Ctrl+Alt+Arrow from there with "Not in a table
// cell". Measured before this existed: tableCells held only the table's summary line and read
// IDENTICALLY on the good and bad pages -- a probe that could not discriminate, which is worse
// than no probe because it looks like evidence.
//
// So: attempt a cell move, and if NVDA says we are not in a cell, step the browse-mode caret
// down one line and try again. Both keystroke routes were checked first -- perform(command) and
// press("Control+Alt+ArrowDown") returned the same message, so delivery was never the problem.
const MAX_CELL_PRIMES = 3;

/** @param {Record<string, any>} K @param {{ trace: string[] }} ctx */
async function enterFirstCell(K, { trace }) {
  for (let i = 0; i < MAX_CELL_PRIMES; i += 1) {
    const phrase = await speechDelta(() => nvda.perform(K.moveToNextRow), "prime").catch(() => "");
    trace.push(`prime[${i}] ${phrase.slice(0, 60) || "(silence)"}`);
    // A boundary message is not a cell. Returning one made the first "cell" in the evidence a
    // message about there being no cell.
    if (phrase && !TABLE_BOUNDARY.test(phrase)) return phrase;
    await withTimeout(nvda.press("ArrowDown"), NAV_TIMEOUT_MS, "prime").catch(() => undefined);
  }
  return "";
}

// Land on a table in either direction; "" when the page has none.
/** @param {Record<string, any>} K */
async function enterFirstTable(K) {
  for (const cmd of [K.moveToNextTable, K.moveToPreviousTable]) {
    await withTimeout(nvda.perform(cmd), NAV_TIMEOUT_MS, "table").catch(() => undefined);
    const phrase = ((await withTimeout(nvda.lastSpokenPhrase(), QUERY_TIMEOUT_MS, "table").catch(() => "")) || "").trim();
    if (phrase && !/\bno (next|previous) table\b/i.test(phrase)) return phrase;
  }
  return "";
}

// What a KEYBOARD user meets, in order, by pressing Tab.
//
// Everything else here runs in browse mode, where NVDA's quick-nav reaches elements by reading
// the accessibility tree. Tab is a different question: it follows the real focus order. An
// element can be perfectly announced in browse mode and be unreachable by keyboard, and a
// focus trap is invisible to every other probe we have. That covers 2.1.2 (No Keyboard Trap),
// 2.4.3 (Focus Order) and skip links (2.4.1).
//
// OPT-IN, because it is the expensive probe: a press plus a focus report is ~2s per stop, so
// twelve stops roughly doubles a 13s capture. The cheap sweeps above are on by default; this
// one is requested per case.
// A SAFETY NET, not the normal terminus. It was 12, which is a number the corpus never notices and real
// pages always hit: measured 2026-08-24 over 77 real pages, the focus probe truncated on 77 of them, and
// overall coverage was 924 tab stops probed against 6,887 focusable elements -- 13.4%. Coverage is
// cap/N, so it FALLS as pages grow: 3.8% on the largest (gov.wales, 312 focusable).
//
// The cost of that was not noise, it was four criteria going undetermined on every real site. A
// truncated focus order makes 2.1.1, 2.1.2, 2.4.1 and 2.4.3 `cantTell` rather than `passed`, which is
// correct -- content past the cap was never examined -- and those four are precisely the criteria this
// project exists to reach. No corpus page has more than 22 focusable elements and 98% have 12 or fewer,
// so every corpus gate was blind to it by construction. ADR 0019's thesis again.
const MAX_TAB_STOPS = 150;
const TRAP_REPEATS = 2;

// The tab order is a CYCLE: past the last control, Tab returns to the first. So a complete pass is
// DETECTABLE, and detecting it is what makes the cap a fallback rather than the usual answer.
//
// Confirmed over several stops rather than one, because a single phrase is ambiguous between "we wrapped"
// and "this control announces exactly like the first one" -- four identical avatar links already cost
// this project a sweep that reported 5 graphics of 66. Requiring the first N to recur IN ORDER makes a
// coincidence vanishingly unlikely without needing to know anything about the page.


// The probe must not eat the capture. At the ~2s per stop this file's own comment records, 312 stops
// would be 624s against a 280s hard capture timeout, so full coverage is not achievable on the largest
// pages at any cap and the honest move is to bound the spend and REPORT the shortfall.
const FOCUS_PROBE_BUDGET_MS = 120_000;



/**
 * The order the two position-dependent probes run in, so a gate can permute them.
 *
 * `capture-core.mjs` carried "ORDER IS LOAD-BEARING from here down" as a constraint to respect. Continuous
 * Delivery names order-dependence as "a major cause of hard-to-track bugs" and prescribes the opposite —
 * atomic steps whose order does not matter, from a known starting point. This option is how that claim gets
 * TESTED rather than asserted: `gate:probe-order` captures a page under two orders and requires the evidence
 * to match.
 *
 * It is expected to FAIL when first run. The sweep walks the document with quick-nav; the focus walk
 * re-anchors and leaves NVDA in focus mode. Whether one disturbs the other has never been measured, and four
 * withdrawn 2.1.2 rules plus a 2.1.1 false positive all came from comparing measurements taken in different
 * states of the page.
 *
 * `default` is the sequence that has always run, so every cached capture stays valid and this ships without
 * a recapture.
 *
 * @param {string | undefined} requested
 * @returns {("sweep" | "focus")[]}
 */
function probeSequence(requested) {
  // A NAME from a fixed set, never a caller-supplied list: an arbitrary sequence could run a probe twice or
  // omit one, and the evidence would then differ for a reason that is not the thing under test.
  if (requested === "focus-first") return ["focus", "sweep"];
  return ["sweep", "focus"];
}

/** @param {{ deadline: number, diag: Diag, controlsOnPage: number }} ctx */
async function probeFocusOrder({ deadline, diag, controlsOnPage }) {
  await anchorToTop();
  const stops = [];
  const budget = Math.min(deadline, Date.now() + FOCUS_PROBE_BUDGET_MS);
  let repeats = 0;
  let cycled = false;
  for (let i = 0; i < MAX_TAB_STOPS; i += 1) {
    if (Date.now() > budget) break;
    await withTimeout(nvda.press("Tab"), NAV_TIMEOUT_MS, "tab").catch(() => undefined);
    const phrase = await reportFocusedControl();
    if (!phrase) break;
    // The same control twice running means Tab stopped moving: either the end of the document
    // or a focus trap. Which one it is, is the judge's call -- record it, do not decide it.
    if (stops.length && phrase === stops[stops.length - 1]) repeats += 1;
    else repeats = 0;
    stops.push(phrase);
    if (repeats >= TRAP_REPEATS) break;
    if (focusOrderCycled(stops)) { cycled = true; break; }
  }
  // Never a silent cap: a truncated focus order looks identical to a short one.
  //
  // `truncated` now means GENUINELY INCOMPLETE -- neither wrapped nor stalled -- rather than "hit the
  // cap", which on real pages was always true and therefore said nothing. It is the value
  // `sweepOutcomes` turns into a `cantTell`, so widening it to mean "we stopped early for any reason"
  // would keep asserting ignorance about pages we walked all the way round.
  diag.mark("focusOrder", {
    stops: stops.length,
    cycled,
    stalled: repeats >= TRAP_REPEATS,
    truncated: !cycled && repeats < TRAP_REPEATS && stops.length > 0,
  });
  markFocusConfinement({ stops, cycled, controlsOnPage, diag });
  return stops;
}

/**
 * Record whether focus was CONFINED to a ring smaller than the page's controls. Presses nothing.
 *
 * THIS PRESSED ESCAPE FOR ONE HOUR AND THE PROBE WAS INERT. The idea was the one thing that could separate
 * a trap from a modal doing its job: on a confinement, press Escape and see whether anything outside the
 * ring becomes reachable. Two 2.1.2 rules had already been withdrawn the same day for lacking exactly that.
 *
 * `anchorToTop` PRESSES ESCAPE AS ITS FIRST ACTION, and `probeFocusOrder` calls it before the walk. So any
 * dialog that responds to Escape is already closed before the ring is measured, and the probe could only
 * ever run on dialogs that ignore it — where it reports "no release" by construction.
 *
 * Measured on a pair built for this, byte-identical apart from one `keydown` handler:
 *
 *     bad   ring 3 of 5 swept, confined,  afterEscape = the same 3 fields, 0 outside the ring
 *     good  ring 12,           NOT cycled, never asked — its dialog was gone before Tab was pressed once
 *
 * The good variant's walk never touched a dialog field. That is the pair discriminating for a reason other
 * than the one it documents, which is this repo's "canary that cannot express the fault".
 *
 * THE USEFUL CONSEQUENCE: a confined ring ALREADY means "confined after an Escape". That is precisely the
 * condition of the rule withdrawn this morning, which produced 7 false positives on 86 conformant real
 * pages — so confinement-despite-Escape is NOT a 2.1.2 failure, and no probe here was going to make it one.
 * Dismissing a consent banner with its Accept button is also "moving focus away using only a keyboard".
 *
 * What is left is the measurement itself, which costs nothing and is worth having: how big the ring was
 * against what the page holds. It is the observability this project lacked while it shipped and withdrew
 * two rules about it.
 *
 * @param {{ stops: string[], cycled: boolean, controlsOnPage: number, diag: Diag }} ctx
 */
function markFocusConfinement({ stops, cycled, controlsOnPage, diag }) {
  const ring = new Set(stops).size;
  diag.mark("focusConfinement", {
    // "Confined" here means: a closed cycle over fewer distinct stops than the sweep found controls —
    // AFTER `anchorToTop` pressed Escape. Reported, never decided: see above for why it cannot be asserted.
    confined: cycled && controlsOnPage > 0 && ring < controlsOnPage,
    cycled, ring, controlsOnPage,
  });
}

/**
 * NVDA's own answer to "how many elements of each type does this document have?"
 *
 * The structural sweeps walk the document with quick-nav, which is RELATIVE: it depends on where the
 * caret is, and what it reports is whatever NVDA happened to speak. That makes two failure modes
 * indistinguishable from a correct result -- a truncated sweep, and a phantom entry recorded from a
 * phrase that was not an element of the requested type at all. A phantom landmark is what moved a
 * conformant page's score across its threshold and flipped the verdict.
 *
 * The Elements List (NVDA+F7) is ABSOLUTE: it enumerates the document irrespective of caret position,
 * and every row in the Landmarks list is by construction a landmark. Its rows are announced as
 * "level 1, form, 1 of 1", so ONE arrow press yields the authoritative total for a type -- which is
 * all a cross-check needs, and keeps the time spent inside a modal dialog to a minimum.
 *
 * `ELEMENT_TYPES` in NVDA's browseMode.py is exactly (link, heading, formField, button, landmark), and
 * the accelerators below come from the labels in that same tuple ("Lan&dmarks" -> Alt+D). The other
 * types we sweep -- graphics, lists, table cells -- are NOT in that dialog, so this can cross-check
 * five of them and no more. That limit is why this supplements the sweep rather than replacing it.
 *
 * Opt-in, and never on by default: it opens a MODAL dialog on the guest desktop, and a modal blocks
 * input, which is exactly how a worker wedges.
 */
// A generous ceiling, not an expectation: it must exceed the longest real list so the count is a
// count rather than a cap, and any truncation is reported rather than silently returned as a total.
const MAX_ELEMENTS_LIST_ROWS = 60;

// The capture path reads LANDMARKS only. That is where the defect is -- quick navigation cannot reach a
// landmark that spans the whole document, so 2,063 of 2,064 corpus captures never named their `<main>`
// -- and reading one type costs a fifth of reading five. The full set stays available for the
// cross-check, which is a verification tool and can afford to be slow.
const LANDMARKS_ONLY_TYPE = "landmark";

const ELEMENTS_LIST_TYPES = [
  { type: "link", accelerator: "Alt+k" },
  { type: "heading", accelerator: "Alt+h" },
  { type: "formField", accelerator: "Alt+f" },
  { type: "button", accelerator: "Alt+b" },
  { type: "landmark", accelerator: "Alt+d" },
];

const EMPTY_TREE_RE = /^tree view(?:,\s*focused)?\.?$/i;

const LANDMARKS_ONLY = ELEMENTS_LIST_TYPES.filter(({ type }) => type === LANDMARKS_ONLY_TYPE);

/**
 * Walk one Elements List tree, returning every row's name in order.
 *
 * Extracted because the loop sat four blocks deep inside the type iteration, but it earns its own name
 * anyway: "read the rows of one tree" is a single job, and it is the part with the subtle stopping
 * rules. Each stop is distinguishable on purpose -- an empty tree, an unparsed row and a hit cap are
 * three different facts, and collapsing them into "0 rows" is what makes an unread probe look like a
 * confident zero.
 */
/**
 * @param {{ type: string, readAfter: (label: string, action: () => Promise<unknown>) => Promise<string[]>,
 *           deadline: number, notes: string[] }} ctx
 */
async function readTreeRows({ type, readAfter, deadline, notes }) {
  const rows = [];
  let previous = null;
  for (let i = 0; i < MAX_ELEMENTS_LIST_ROWS; i += 1) {
    if (Date.now() > deadline) { notes.push(`${type}: deadline after ${rows.length} row(s)`); break; }
    const spoken = await readAfter(`row-${type}-${i}`, () => nvda.perform(nvda.keyboardCommands.reportCurrentFocus));
    const phrase = spoken[spoken.length - 1] ?? "";
    // An empty tree names no item, so this type genuinely has none. It is the only safe way to read
    // zero: silence would mean "could not tell", and recording that as zero manufactures a finding.
    if (EMPTY_TREE_RE.test(phrase)) break;
    const name = elementsListRowName(phrase);
    if (!name) { notes.push(`${type}: unparsed ${JSON.stringify(phrase).slice(0, 60)}`); break; }
    if (name === previous) break; // ArrowDown stopped moving: this was the last row
    rows.push(name);
    previous = name;
    await readAfter(`down-${type}-${i}`, () => nvda.press("ArrowDown"));
  }
  if (rows.length >= MAX_ELEMENTS_LIST_ROWS) notes.push(`${type}: hit the row cap, so the count is a floor`);
  return rows;
}

/**
 * Read the Elements List's authoritative per-type totals.
 *
 * Kept deliberately small: select a type by its accelerator, land on one row, parse the "N of M" NVDA
 * appends, move on. One row is enough for the total, and every extra keystroke is time spent with a
 * modal dialog open on the guest desktop.
 *
 * A type with no elements speaks NOTHING when arrowed -- measured on a page NVDA reports no landmarks
 * for -- so an empty delta is a genuine zero rather than a failed read. That distinction is only safe
 * because the dialog itself was confirmed to speak ("Elements List, dialog" -> "tree view") before
 * this was written; if the dialog were silent, zero and unread would be the same observation.
 */
/** @param {{ deadline: number, diag: Diag, types?: { type: string, accelerator: string }[] }} ctx */
async function probeElementsListCounts({ deadline, diag, types = LANDMARKS_ONLY }) {
  const K = nvda.keyboardCommands;
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Record<string, string[]>} */
  const items = {};
  /** @type {string[]} */
  const notes = [];
  /** @type {{ step: string, spoken: string[], channelReset?: boolean }[]} */
  const trace = [];
  // The offset advances instead of being re-read before every keystroke. Reading it twice per keystroke
  // doubled the round trips, and round trips are the entire cost here: all five types measured 39s on
  // top of a 20s capture, which is unaffordable for a 2,122-capture corpus.
  let seen = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "elementsListSeed").catch(() => [])) || []).length;
  const readAfter = async (/** @type {string} */ label, /** @type {() => Promise<unknown>} */ action) => {
    await withTimeout(action(), NAV_TIMEOUT_MS, label).catch(() => undefined);
    const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label).catch(() => [])) || [];
    // A shrunken log means the speech channel was rebuilt; resynchronise rather than mis-slice.
    if (log.length < seen) { seen = log.length; trace.push({ step: label, spoken: [], channelReset: true }); return []; }
    const spoken = log.slice(seen).map((/** @type {unknown} */ phrase) => String(phrase).trim()).filter(Boolean);
    seen = log.length;
    // Every keystroke's speech, because this dialog's focus behaviour has now been guessed wrong twice:
    // arrowing without tabbing cycled the radio GROUP, and tabbing on every type walked focus OUT of
    // the tree. A trace makes the next question answerable from one run instead of another deploy.
    trace.push({ step: label, spoken });
    return spoken;
  };

  try {
    const opened = await readAfter("elementsListOpen", () => nvda.perform(K.browseModeElementsList));
    // If the dialog did not announce itself it may not have opened, and arrowing blind inside the
    // DOCUMENT instead would move the caret and corrupt everything measured after this.
    if (!opened.some((/** @type {string} */ phrase) => /elements list/i.test(phrase))) {
      diag.mark("elementsList", { opened: false, spoken: opened });
      return null;
    }
    for (const { type, accelerator } of types) {
      if (Date.now() > deadline) { notes.push(`${type}: deadline`); break; }
      await readAfter(`select-${type}`, () => nvda.press(accelerator));
      // Tab to the tree, then Home for its FIRST row. The accelerator leaves focus on the radio group
      // (arrowing there cycles TYPES, which shifted every reading by one), and ArrowDown from the tree
      // container announced nothing at all -- both measured on the guest.
      await readAfter(`tab-${type}`, () => nvda.press("Tab"));
      await readAfter(`home-${type}`, () => nvda.press("Home"));
      const rows = await readTreeRows({ type, readAfter, deadline, notes });
      if (rows.length >= MAX_ELEMENTS_LIST_ROWS) notes.push(`${type}: hit the row cap, count is a floor`);
      counts[type] = rows.length;
      items[type] = rows;
    }
  } finally {
    // UNCONDITIONAL, and twice. This is a MODAL dialog: leaving it open blocks input on the guest and
    // wedges the next capture, which is a fault that once took two days to attribute correctly. Never
    // let closing it depend on anything above succeeding.
    for (let i = 0; i < 2; i += 1) {
      await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "escDialog").catch(() => undefined);
    }
  }
  diag.mark("elementsList", { opened: true, counts, items, notes, trace });
  return counts;
}

// Operate the control under the cursor and record what the screen reader says —
// the lived-experience signal a static read cannot see. Activating in place is
// required: a separate next/previous sweep finds nothing, because after the
// structural sweep the cursor sits at the end and the only control is the
// current position, not a next one.
/**
 * Construct the probe this announced control earns. The DECISION is `probeKindFor` in `capture-pure.mjs`;
 * this is only the dispatch.
 *
 * Split because that decision is the safety gate on what this tool PRESSES, and `probe-forms` now
 * defaults on in the GitHub Action — so "would this activate somebody's *Delete account* button?" has to
 * be answerable by a test. It could not be before: `capture-core` imports guidepup, which throws at
 * module load where no screen reader exists, so no test can import this file (see `pure-graph.test.ts`).
 */
/** @param {string} phrase @param {Record<string, any>} ctx */
function chooseProbe(phrase, ctx) {
  switch (probeKindFor(phrase, ctx)) {
    case "disclosure": return () => probeDisclosure(phrase, ctx);
    case "submit": return () => probeFormSubmit(phrase, ctx);
    case "task": return () => probeTaskButton(phrase, ctx);
    case "toggle": return () => probeToggle(phrase, ctx);
    default: return null;
  }
}

/**
 * Activate a control, then ALWAYS put NVDA back in browse mode.
 *
 * The restore is not defensive tidying; without it this pipeline **typed its own keystrokes into the
 * pages it was measuring**, on 125 captures of the corpus.
 *
 * The chain, from NVDA's source rather than inference:
 *
 * 1. Activating a control moves focus. An accessible form moves it to the field it just rejected; a
 *    disclosure moves it into what it opened (gov.uk's "Show search menu" focuses its search combo box).
 * 2. That is a real focus change, so `browseMode.shouldPassThrough` is consulted with
 *    `OutputReason.FOCUS`, `autoPassThroughOnFocusChange` defaults to **true** in NVDA's `configSpec`,
 *    and `State.EDITABLE in states` returns True — **focus mode on**.
 * 3. In focus mode a character gesture is passed to the application instead of NVDA's browse-mode
 *    scripts, so the quick-navigation letters ARE THE INPUT. And it sticks: `QuickNavItem.moveTo`
 *    returns early, still in focus mode, whenever the next target is focusable.
 *
 * So the sweeps that follow type their own commands into the page. Decoded from apache.org's search box:
 *
 *   FFffGGggKKkkLLll   =   Shift+F,Shift+F,f,f  Shift+G,Shift+G,g,g  Shift+K,Shift+K,k,k  Shift+L,…
 *                          formField prev/next  graphic              link                 list
 *
 * apache.org then search-as-you-typed it and rendered "1 result for FFffGGggKKkkLLll", which this tool
 * read as a page behaviour. It was our own.
 *
 * Two consequences, both measured on the 2,122-capture corpus:
 *
 * - `links`, `graphics` and `lists` come back EMPTY after any activation — 353 captures — and an empty
 *   sweep is indistinguishable from a page that has none of that element.
 * - The leak is **asymmetric across a pair**: 125 pairs carry it on ONE variant and 0 on both, always the
 *   good one, because only an accessible form focuses the field it rejected. A pair differing by an
 *   artefact of the measuring tool is the exact defect the U+FFFC autofill investigation was about — and
 *   worse here, since the artefact correlates with the property under test and is therefore a shortcut
 *   feature available to the trained scorer.
 *
 * Escape is the key, because NVDA's own `script_disablePassThrough` carries
 * `ignoreTreeInterceptorPassThrough = True` — it is specifically built to be reachable FROM focus mode,
 * which is what makes it the one gesture that can get back out. In browse mode it is already a no-op
 * pass-through.
 *
 * Sent with `nvda.press("Escape")`, NOT `nvda.perform(keyboardCommands.exitFocusMode)`. Both are Escape on
 * paper and only the first works here — measured on apache.org, where `perform` left every following sweep
 * stopping on `repeat` with 0 links and `press` did not. `anchorToTop` has used `press` for this exact
 * purpose all along, and its comment names this NVDA behaviour; the remedy was simply never applied to the
 * sweeps, which is why the post-submit re-read was the one sweep that never broke.
 *
 * Escape alone, deliberately: `anchorToTop` follows it with Ctrl+Home, and rewinding the cursor to the top
 * of the document mid-sweep would make the sweep re-walk ground it has covered and stop early on its own
 * duplicates.
 */
/** @param {string} phrase @param {Record<string, any>} ctx */
async function operateControl(phrase, ctx) {
  const probe = chooseProbe(phrase, ctx);
  if (!probe) return undefined;
  try {
    return await probe();
  } finally {
    await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "browseMode")
      // Recorded as an ERROR because it is one: a failed restore leaves NVDA typing this pipeline's own
      // quick-navigation keys into the page under test, and `verify.corpus.test.ts` fails the corpus on
      // any sweepLog ERROR. Swallowing it is what let the leak run for 2,122 captures.
      .catch((e) => ctx.interaction.sweepLog.push(`browseMode ERROR ${errMsg(e)}`));
    // Escape makes NVDA re-announce the document, and that phrase must land HERE rather than in whatever
    // runs next. Bleeding into a sweep would be worse than bleeding into a delta: `sweepStepFromSpeech`
    // reads new speech as proof of movement, so a stray phrase becomes a phantom element.
    await waitForSpeechQuiet("browseModeSettle");
  }
}

// Activate a disclosure (safe — it just toggles visibility) and record the state it
// exposes afterwards, so a control that never updates its state is caught (4.1.2
// Name, Role, Value).
//
// We RE-READ the control rather than listening for a spontaneous announcement,
// because the spontaneous route cannot separate a conformant disclosure from a
// broken one. Measured on NVDA 2026.1.1: activating either fixture announces only a
// document re-announce (~625ms) — "expanded" is never spoken, and neither
// `lastSpokenPhrase` nor the `spokenPhraseLog` delta contains it. Judging on that
// meant a broken disclosure could look identical to a working one.
//
// Re-reading asks the accessibility tree instead: has the control's state actually
// changed? That is precisely what 4.1.2 requires, and it is deterministic. The
// spontaneous announcement is still recorded in the sweep log as evidence.
/** @param {string} phrase @param {Record<string, any>} ctx */
async function probeDisclosure(phrase, { interaction }) {
  try {
    const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "disclosure")) || []).length;
    await withTimeout(nvda.act(), ACT_TIMEOUT_MS, "disclosure"); // Enter on the control under the cursor
    // Wait for what was announced, rather than 1.2s regardless. Same reasoning as the other activation
    // probes: a fixed sleep is too long when the page answers immediately and too short in the tail,
    // and here the tail is what matters -- this is the probe whose timeout got recorded as silence.
    const log = await waitForAnnouncement(before, "disclosure");
    const announced = log.slice(before).map((/** @type {unknown} */ s) => String(s).trim()).filter(Boolean).join(" | ");
    const after = await reportFocusedControlWithRetry(interaction);
    interaction.sweepLog.push(
      `disclosure ${JSON.stringify(phrase.slice(0, 40))} announced=${JSON.stringify(announced)} state=${JSON.stringify(after)}`
    );
    interaction.stateChanges.push({ control: phrase, after });
  } catch (e) {
    // **A failed measurement is not silence, and must never be recorded as one.**
    //
    // Measured on disclosure-state-silent/good over 20 captures: 19 recorded the state change and 1
    // recorded nothing, because `reportFocus timed out after 6000ms` threw and this catch dropped the
    // entry. An empty `stateChanges` is precisely the signature of the BAD variant -- a disclosure that
    // never announces its state -- so 1 in 20 captures of a CORRECTLY implemented page was
    // indistinguishable from a broken one. That does not add noise, it inverts the finding, and it
    // would teach a judge that a conformant page fails 4.1.2.
    //
    // The entry is still recorded, carrying the error instead of a state. Downstream can then tell
    // "we did not measure" from "there was nothing to hear" -- and `check-signals` sees a probe that
    // errored rather than a page that was silent.
    interaction.sweepLog.push(`disclosure ERROR ${errMsg(e)}`);
    interaction.stateChanges.push({ control: phrase, after: null, error: errMsg(e) });
  }
}

/**
 * Re-read the focused control, retrying a timeout.
 *
 * This is a pure read of the accessibility tree -- no side effects on the page -- so retrying is safe,
 * and a timeout here is the difference between recording a state change and recording nothing at all.
 * Measured failure rate before this: 1 in 20.
 */
/** @param {Record<string, any>} interaction @param {number} [attempts] */
async function reportFocusedControlWithRetry(interaction, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await reportFocusedControl();
    } catch (e) {
      if (attempt >= attempts) throw e;
      interaction.sweepLog.push(`disclosure reportFocus retry ${attempt}: ${errMsg(e)}`);
      await sleep(STATE_POLL_MS);
    }
  }
}

// Ask NVDA to re-announce the focused control, and return that announcement — which
// carries the control's CURRENT state ("... button, focused, expanded").
async function reportFocusedControl() {
  await withTimeout(
    nvda.perform(nvda.keyboardCommands.reportCurrentFocus), NAV_TIMEOUT_MS, "reportFocus"
  );
  // Read as soon as there is something to read, rather than 1.2s later regardless.
  //
  // `nvda.perform` already resolves event-driven: guidepup's enqueueAndTap waits for a quiet period on
  // the speech channel before returning (SPEAK_DEBOUNCE_TIMEOUT, 1000ms in NVDAClient.js). Sleeping a
  // further 1.2s on top of that was waiting twice for the same thing, on the hottest path in the
  // disclosure probe.
  //
  // An empty phrase is still possible for a beat, so this polls rather than assuming -- with a
  // deadline, because a control that announces nothing must remain an observable outcome rather than
  // becoming a hang.
  const deadline = Date.now() + STATE_WAIT_MS;
  for (;;) {
    const phrase = ((await withTimeout(nvda.lastSpokenPhrase(), QUERY_TIMEOUT_MS, "reportFocus")) || "").trim();
    if (phrase || Date.now() >= deadline) return phrase;
    await sleep(STATE_POLL_MS);
  }
}

// Activate the control under the cursor and capture EVERY phrase announced
// afterwards, not just the last one: a live-region status (4.1.3) can be followed
// by a focus move or document re-announce that overwrites lastSpokenPhrase, so we
// keep the spokenPhraseLog delta. An empty delta means the action conveyed
// nothing to the screen reader.
/**
 * Wait for the announcement an activation produced, rather than guessing how long it takes.
 *
 * Poll until the spoken log grows, then keep polling until it goes quiet, then stop. Fast when the
 * page announces promptly -- which is almost always -- and patient when it does not.
 *
 * The asymmetry is deliberate and is the whole point: a page that announces nothing must still be
 * allowed to announce nothing. So this returns an empty delta only after STATE_WAIT_MS of genuine
 * silence, never because a fixed sleep expired first.
 *
 * @returns {Promise<string[]>} the full spoken log, for the caller to slice from `before`
 */
/** @param {number} before @param {string} kind */
async function waitForAnnouncement(before, kind) {
  const deadline = Date.now() + STATE_WAIT_MS;
  let log = [];
  while (Date.now() < deadline) {
    log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, kind)) || [];
    if (log.length > before) break;
    await sleep(STATE_POLL_MS);
  }
  if (log.length <= before) return log; // genuinely silent -- the finding, not a failure
  // Something was said; let the rest of it arrive before reading the delta.
  let settled = log.length;
  const quietBy = () => Date.now() + STATE_QUIET_MS;
  for (let quiet = quietBy(); Date.now() < quiet && Date.now() < deadline;) {
    await sleep(STATE_POLL_MS);
    log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, kind)) || [];
    if (log.length > settled) { settled = log.length; quiet = quietBy(); }
  }
  return log;
}

/**
 * Is everything heard so far the CONTROL's own state rather than the PAGE's answer?
 *
 * NVDA speaks "checked" for a checkbox and "expanded" for a disclosure whatever the page does, so those
 * phrases are the screen reader describing the control, not the page responding to it. `case-matrix.mjs`
 * makes the same distinction on the reading side in `pageResponseTo`; this is the capture side, and the
 * two are pinned by `toggle-state-parity.test.ts`.
 *
 * Empty counts as "only state", because a page that has said nothing has certainly not answered yet.
 */
const CONTROL_OWN_STATE = /^(?:not\s+)?(?:checked|pressed|selected|expanded|collapsed)$/i;

/** @param {unknown[]} phrases */
function onlyControlState(phrases) {
  return phrases.every((phrase) => {
    const text = String(phrase ?? "").trim();
    return text === "" || CONTROL_OWN_STATE.test(text);
  });
}

/**
 * Wait again when everything heard so far is the control's OWN state.
 *
 * A BUTTON announces nothing of its own, so the first phrase after activating one IS the page's answer and
 * `filter-status-silent` has always been reliable. A checkbox says "checked" first — which satisfies
 * "something was said" and starts `waitForAnnouncement`'s quiet window — and `aria-live="polite"` means
 * *speak when idle*, so a live region waits for the very silence that ends it.
 *
 * MEASURED, AND IT IS NOT ENOUGH. Six repeats of one unchanged page put the region in the delta 2 times in
 * 6 before this existed and 2 times in 6 after. The announcement is intermittent AT NVDA; no wait catches
 * what was never spoken. Kept because the reasoning is sound and it costs one quiet window on a silent
 * toggle, and INSTRUMENTED because a remedy that cannot report itself is one this project has shipped
 * inert three times — `refreshBrowseBuffer` sat dead through three green runs for want of exactly this.
 *
 * @param {string[]} log @param {number} before @param {string} kind @param {any} interaction
 * @returns {Promise<string[]>} the log, extended if a second wait heard anything
 */
async function waitPastControlState(log, before, kind, interaction) {
  if (!onlyControlState(log.slice(before))) return log;
  const second = await waitForAnnouncement(log.length, kind);
  interaction.sweepLog.push(`${kind} SECOND-WAIT-AFTER-OWN-STATE caught=${second.length > log.length}`);
  return second.length > log.length ? second : log;
}

/** @param {string} phrase @param {Record<string, any>} interaction @param {string} kind */
async function activateAndCaptureDelta(phrase, interaction, kind) {
  try {
    // Settle BEFORE reading the baseline, or something already in flight is attributed to this
    // activation. Measured: one capture of `filter-status-silent/bad` in the corpus recorded
    // `after: "Energy results, document"` — NVDA's document announcement, arriving late from an earlier
    // step — on a page whose entire finding is that activating the filter announces NOTHING. Six repeats
    // of the same page produced the correct empty delta, so it is a race at roughly 1 in 125 activations,
    // and 1 in 125 is enough: that single record was the one false negative that made the retrained
    // scorer fail its release gate.
    //
    // `waitForAnnouncement` already guards the other end. This is its missing counterpart, and the
    // asymmetry is why the hole survived: the code waited carefully for speech to arrive and not at all
    // for the previous speech to finish.
    // The RESULT is consumed, which is the half that was missing. `waitForSpeechQuiet` returns
    // `{quiet:false}` when its budget runs out with NVDA still talking, and its own JSDoc promises that
    // is "recorded, never silently treated as settled" — but all ten call sites discarded it, so no code
    // path anywhere behaved differently when the guard gave up. A guard whose only failure signal has no
    // consumer is not a guard: on a slow path it degrades back into the fixed sleep it replaced, with the
    // same consequences and none of the visibility.
    //
    // That is why this survived. The budget was too short for a browser recycle AND nothing could say so.
    const baseline = await waitForSpeechQuiet(`${kind}Baseline`, BASELINE_QUIET_BUDGET_MS);
    if (!baseline.quiet) {
      // Recorded where it reaches the capture file and the corpus test, not merely returned. Both
      // possible outcomes are untrustworthy once this fires: a non-empty delta may be the previous
      // step's speech, and an EMPTY one may be a real announcement we stopped listening for — and on
      // these pages an empty delta is the finding, so it cannot be read as clean either.
      interaction.sweepLog.push(
        `${kind} BASELINE-NOT-QUIET waited=${baseline.waitedMs}ms reads=${baseline.reads} `
        + "-- this delta is not trustworthy in either direction",
      );
    }
    const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, kind)) || []).length;
    await withTimeout(nvda.act(), ACT_TIMEOUT_MS, kind); // Enter on the control under the cursor
    let log = await waitForAnnouncement(before, kind);
    // A CONTROL THAT ANNOUNCES ITS OWN STATE STARTS THE SETTLE CLOCK, and a polite live region loses the
    // race to it. MEASURED 2026-09-01, six repeats of one unchanged page: the region reached the delta
    // 2 times in 6, and `gate:stability` reported `VARIES formChanges counts 1,1,1,1,1,1` -- the count
    // never moved, only the CONTENT, which is precisely the rot a count-based check cannot see.
    //
    // The mechanism is exact rather than suspected. `waitForAnnouncement` waits for the first phrase and
    // then for quiet; a BUTTON announces nothing of its own, so the first phrase IS the live region and
    // `filter-status-silent` has always been reliable. A checkbox says "checked" first, which satisfies
    // "something was said" and starts the quiet window -- and `aria-live="polite"` means *speak when
    // idle*, so the region deliberately waits for the silence that ends that window.
    //
    // So when everything heard so far is the control's OWN state, nothing has been heard FROM THE PAGE
    // yet and the wait is not finished. Asking again is a condition, not a longer sleep: a page that
    // truly says nothing pays one more quiet window and still reports the empty delta that IS the
    // finding.
    log = await waitPastControlState(log, before, kind, interaction);
    const after = log.slice(before).map((/** @type {unknown} */ s) => String(s).trim()).filter(Boolean).join(" | ");
    interaction.sweepLog.push(`${kind} ${JSON.stringify(phrase.slice(0, 40))} -> ${JSON.stringify(after)}`);
    // `kind` travels with the evidence, because criteria mean different things per activation.
    // 3.3.1 is about a SUBMIT that was rejected silently; it was previously satisfied by any non-empty
    // formChanges, so opening a disclosure counted -- and apache.org's SEARCH toggle was reported as a
    // form submitted with invalid input and no error announced. Nothing was submitted and nothing was
    // invalid.
    // `baselineQuiet` travels WITH the entry, for the same reason `kind` does: a consumer deciding what
    // this activation proves needs to know whether the measurement was sound. Carried on the evidence
    // rather than left in a log, because a log nothing reads is a comment — this repo lost 604 captures
    // to a crash that was faithfully written to `sweepLog` and never once read.
    // And the MARGIN, not just the verdict. Measured 2026-09-01 on the authoritative corpus: `baselineQuiet`
    // is `false` on 0 of 1,117 stated entries -- so the 20 s budget always wins, and the honest response to
    // that was NOT to condition a feature on a value that never occurs. But "settles comfortably" and
    // "settles at 19.9 s of 20" print the same `true`, and they are the difference between a robust wait
    // and one record from the cliff. The budget was raised once already because it was too short for a
    // browser recycle AND nothing could say so; recording the wait is what stops that recurring silently.
    const entry = { control: phrase, kind, after, baselineQuiet: baseline.quiet, baselineWaitedMs: baseline.waitedMs };
    interaction.formChanges.push(entry);
    // RETURNED as well as pushed, so a caller that needs the result does not have to reach into the array
    // and assume its own entry is the last one. `probeRouteChange` needs it; the three existing callers
    // ignore it and are unaffected.
    return entry;
  } catch (e) {
    interaction.sweepLog.push(`${kind} ERROR ${errMsg(e)}`);
    // Null, distinctly from an entry whose `after` is empty: "we could not measure" and "the page said
    // nothing" are opposite findings on the criteria this feeds, and returning undefined for both is how
    // that distinction gets lost at the next call site.
    return null;
  }
}

/**
 * 2.4.2, the half a screen reader is uniquely placed to prove: **does navigating tell you where you went?**
 *
 * The detectable-by-absence half of Page Titled is not worth a probe. Measured across 4,895 captures there
 * are ZERO missing or placeholder titles, WebAIM's million-page survey does not list missing title among the
 * failures covering 96% of errors, and the documented real-world failures are the "does not describe its
 * topic" kind, which is human judgement — W3C flags 2.4.2 on a page whose title reads
 * "Welcome to CityLights! [Inaccessible Survey Page]". A rule there adds a row to the coverage table
 * without adding any detection.
 *
 * The half that matters is the single-page app: the route changes, the content changes, and
 * `document.title` does not — so the screen reader still says the previous page's name, and a user
 * navigating by title has no way to know they moved. A static analyser cannot see it (the markup is
 * correct at every instant) and neither can a capture that reads the title ONCE, at entry, which is what
 * every capture before this one did.
 *
 * So the measurement is the screen reader's own answer, twice: ask NVDA what the page is called, activate a
 * navigation control, ask again. Both readings come from `reportTitle`, the same command that populates
 * `documentReady.title`, so this is the user's experience rather than an inference about the DOM.
 *
 * Runs LAST and only when asked. Activating a link is the one probe that can leave the page under
 * measurement, so everything position-dependent has already finished — the same ordering rule that governs
 * `probeFocusOrder` and the Elements List, for a stronger reason.
 *
 * **It activates the FIRST link on the page, and that is a real limitation rather than a detail.** On a
 * synthetic case the fixture puts the navigating link first; on a real site the first link is as likely to
 * be a skip link, a logo or a cookie banner, and activating it proves nothing about routing. So a `null`
 * or unchanged result here means "this page's first link did not navigate", NOT "this page fails 2.4.2" —
 * which is why the signal requires the title to be unchanged AND nothing to have been announced, and why
 * `navigated` travels with the evidence. Aiming it at a nav landmark, or at a link whose href changes the
 * route, is the obvious next step and is deliberately not guessed at here.
 */
/** One Tab from wherever activation left us, and what it announced. */
/** @param {string} kind */
async function focusedAfterTab(kind) {
  try {
    await withTimeout(nvda.press("Tab"), NAV_TIMEOUT_MS, kind).catch(() => undefined);
    return (await reportFocusedControl()) || "";
  } catch {
    // Null, never "": an empty announcement is a real observation here (focus went somewhere silent) and a
    // failed measurement must not be recorded as one.
    return null;
  }
}

/** @param {string} kind */
async function firstHeadingFromTop(kind) {
  await anchorToTop();
  const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, kind)) || []).length;
  await withTimeout(nvda.perform(nvda.keyboardCommands.moveToNextHeading), NAV_TIMEOUT_MS, kind)
    .catch(() => undefined);
  const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, kind)) || [];
  return log.slice(before).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean).join(" | ");
}

/**
 * Why the probe reached no link, or "" when it reached one.
 *
 * Two ways to reach nothing and they must not be recorded the same way. Silence is one. The other is
 * NVDA ANNOUNCING THE END: quick-nav past the last link says "no next link", and that string was taken
 * for the NAME of a control the probe had activated — on gov.scot/publications 2.4.2 reported
 * `after activating "no next link" the page moved to "AUGUST 2025, heading, level 2"`. Nothing was
 * activated; the caret moved, which is what quick-nav does.
 *
 * `sweepInDirection`'s own lesson, reaching the one probe that never learned it: prefer the screen
 * reader's answer over an inference about its behaviour, and `exhausted` is the sound terminus.
 */
/** @param {string} control */
function noLinkReached(control) {
  if (!control) return "no-link";
  return NOTHING_FURTHER_RE.test(control) ? "exhausted" : "";
}

/**
 * NVDA saying there is nothing further of a type, in the phrasings it uses.
 *
 * The screen reader announces the end of a page — "no next link", "no previous heading" — and that is a
 * TERMINUS, not a control. Matching it here rather than only in the rule means the capture records the
 * fact rather than a fiction the rule has to undo later.
 */
const NOTHING_FURTHER_RE = /\bno (next|previous) \w+/i;

/**
 * Put NVDA back in browse mode after a probe that deliberately entered focus mode.
 *
 * NOT OPTIONAL, AND A GUARD CAUGHT IT MISSING. `landOnControl` enters focus mode so the keys that follow
 * reach the application — and under `probeOrder: "focus-first"` the structural sweep runs AFTERWARDS. In
 * focus mode a quick-navigation letter is not a command, it is INPUT: the sweep types `hhkkllgg` into the
 * page it is measuring. That is the 353-capture contamination this file already documents at length,
 * reintroduced by a probe that borrowed focus and did not give it back.
 *
 * Measured 2026-09-01, and it never reached the corpus: `training:capture` rejected all three attempts on
 * both cases with *"the read-through announced a heading but the heading sweep found none — the page was
 * not traversed"*. The cross-check that refuses a capture contradicting itself is what stopped it.
 *
 * Uses the same `BROWSE_MODE_REMEDIES` ladder the sweep uses rather than a second spelling of Escape:
 * `press("Escape")` first, then `moveToContainingBrowseModeDocument` for a panel behaving like an embedded
 * document, which apache.org needed and Escape alone did not fix.
 *
 * @param {string} label @param {Diag} diag
 */
async function restoreBrowseMode(label, diag) {
  // `anchorToTop`, NOT the `BROWSE_MODE_REMEDIES` ladder, and getting that wrong cost a capture round.
  //
  // That ladder is an ESCALATION the sweep applies ONE AT A TIME, testing between -- its own comment says
  // "neither is trusted; both are tested by whether the next step still echoes". Applied blindly as a
  // sequence it is worse than the first remedy alone, because `moveToContainingBrowseModeDocument` is a
  // TOGGLE: run when Escape has already left focus mode, it goes back in.
  //
  // Measured 2026-09-01: the arrow probe worked perfectly -- arrows moved 1 -> 2 -> 3 through the radio
  // group -- and the capture was still rejected, because the sweep that followed sweept 0 headings on a
  // page with an h1. `arrowNavBrowseRestored` was marked, so the restore HAD run; it was the restore
  // itself that put the mode back.
  //
  // `anchorToTop` is the proven route and does both halves at once: it presses Escape -- NVDA's own way
  // out, and `press` rather than `perform(exitFocusMode)`, measured -- and then `Control+End`, which is
  // exactly where the sweep expects the caret. Quick navigation cannot reach an element the caret is ON,
  // so leaving the caret mid-page silently costs the sweep one element of each type.
  // AND REBUILD THE BUFFER. `anchorToTop` restores the MODE and the caret; it does not rebuild NVDA's
  // browse-mode buffer, which belongs to the window and which focus mode leaves stale.
  //
  // Measured 2026-09-01 with the anchor alone: the sweep ran and NVDA was SILENT in both directions --
  // `observed.headings.stop = {prev: "silent", next: "silent"}`, 0 headings and 0 form fields on a page
  // that has both. That is not a mode that failed to restore, it is a buffer with nothing in it, and
  // `refreshBrowseBuffer` is this file's existing remedy for exactly that.
  await refreshBrowseBuffer(diag);
  await anchorToTop();
  // MARKED WHENEVER IT RUNS, so "did not need to restore" and "never ran" can never be the same silence --
  // the `refreshBrowseBuffer` rule, which sat inert through three green runs for want of exactly this.
  diag.mark(label + "BrowseRestored", { via: "anchorToTop" });
}

/**
 * Drive a form into the state a config declared, then submit it — ADR 0024's states model, in the worker.
 *
 * ONE state per capture, and the host issues one capture per state. That is forced rather than chosen: an
 * error submission leaves a dirty form and an error banner, and a success submission may navigate away,
 * so a second state cannot start from the first. It also keeps the evidence channels FLAT — nesting
 * per-state evidence inside one capture would reshape the arrays that 28 files read.
 *
 * WHAT IT REPORTS IS THE POINT. `filled` and `unbound` are both recorded, because a field the config named
 * and the page did not offer is not a no-op: it may be a page that changed, or a name that drifted, or a
 * control with no accessible name — which is the 4.1.2 finding the whole addressing scheme turns on. A
 * silent skip would make a half-filled form indistinguishable from a filled one.
 *
 * @param {{formState: {state: string, submit: string, fields: {field: string, within?: string, nth?: number}[]},
 *   interaction: Record<string, unknown>, deadline: number,
 *   diag: Diag}} args
 */
async function fillFormState({ formState, interaction, deadline, diag }) {
  const wanted = (formState.fields || []).map((field, index) => ({ ...field, index, done: false }));
  const filled = [];
  const seenPerName = new Map();

  await anchorToTop();
  let previous = "";
  let step = 0;
  for (; step < MAX_FILL_STOPS; step += 1) {
    if (Date.now() > deadline) { diag.mark("formFill", { stopped: "deadline", step }); break; }
    if (wanted.every((field) => field.done)) break;
    const announced = await advanceToNextField("formFill");
    // NVDA announces the end of a page rather than going silent, so an unchanged phrase is the terminus.
    // The sweep learned this the expensive way: stopping on silence guessed, and a log delta proves
    // movement where repetition only suggests it.
    if (!announced || announced === previous) { diag.mark("formFill", { stopped: "exhausted", step }); break; }
    previous = announced;

    const match = nextMatchFor(announced, wanted, seenPerName);
    if (!match) continue;
    const fill = fillActionFor(match);
    if (!fill) { diag.mark("formFill", { skipped: "no verb", field: match.field }); continue; }
    await applyFill(fill, "formFill", diag);
    match.done = true;
    filled.push({ field: match.field, action: fill.action });
    // RE-ANCHOR AND RESTART, because `applyFill` ends in `restoreBrowseMode`, which anchors — so the
    // caret is back at the end of the document and this walk's position is gone. Resuming from there
    // would silently re-examine the tail and miss everything before it, which is how the first version
    // filled one field of two and reported the other `unbound`.
    //
    // Restarting is O(fields x stops) and that is the right trade: the walk is a few keystrokes per stop
    // against a capture already measured in minutes, and a fill that quietly skips a field submits a form
    // in a state the config does not describe.
    await anchorToTop();
    previous = "";
    seenPerName.clear();
  }

  // RAN OUT OF STEPS and RAN OUT OF PAGE must not be the same evidence, and the loop bound alone makes
  // them so: both leave fields `unbound`. The budget is a TOTAL across restarts — each fill re-anchors and
  // re-walks — so a form with many fields can reach it while every field it named still exists. Saying
  // which happened is the difference between "your config names a field this page does not have" and
  // "this tool gave up", and those need opposite fixes.
  if (step >= MAX_FILL_STOPS) diag.mark("formFill", { stopped: "budget", steps: step, cap: MAX_FILL_STOPS });
  const unbound = wanted.filter((field) => !field.done).map((field) => field.field);
  interaction.formFill = { state: formState.state, filled, unbound };
  diag.mark("formFill", { state: formState.state, filled: filled.length, unbound });
  return { filled, unbound };
}

/**
 * One step of the form-field quick-nav, reporting what NVDA said about where it landed.
 * FORWARD, and the reason is measured rather than reasoned — the first version of this comment argued
 * the opposite and was wrong.
 *
 * `anchorToTop` is named for the mode it restores, not the position: it presses Escape and then
 * **Control+End**, so the caret sits at the END of the document. That reads like an argument for walking
 * BACKWARDS, and it is not: NVDA's quick navigation WRAPS, so `moveToNextFormField` from the end lands on
 * the first field and walks the page in reading order. Switching to `moveToPreviousFormField` was tried on
 * a W3C tutorial page with eight form fields and filled ZERO, against one for the forward walk.
 *
 * The lesson is the change itself. Two things were altered at once — the direction and the re-anchoring
 * below — and the result got worse, which made neither attributable. The re-anchoring was the fix that had
 * actually been diagnosed; the direction was a guess riding along with it.
 *
 * The command is read off `nvda` here rather than passed in: guidepup owns that type, and describing it
 * at this boundary would be a second spelling of somebody else's contract.
 *
 * @param {string} label
 * @returns {Promise<string>}
 */
async function advanceToNextField(label) {
  const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label).catch(() => [])) || []).length;
  await withTimeout(nvda.perform(nvda.keyboardCommands.moveToNextFormField), NAV_TIMEOUT_MS, label)
    .catch(() => undefined);
  const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label).catch(() => [])) || [];
  return log.slice(before).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean).join(" ");
}

/**
 * Which unfilled spec, if any, this announcement satisfies — including the `nth` bookkeeping.
 *
 * `nth` counts the controls matching that NAME as they are ENCOUNTERED, which is the only counting a
 * one-pass walk can do and is also how the draft assigned the numbers. Kept here rather than inline so the
 * loop above reads as a narrative and this fiddly part is nameable.
 */
/**
 * @param {string} announced
 * @param {({field: string, within?: string, nth?: number, done: boolean}
 *   & {value?: string, choose?: string, check?: boolean})[]} wanted
 * @param {Map<string, number>} seenPerName
 * @returns {({field: string, within?: string, nth?: number, done: boolean}
 *   & {value?: string, choose?: string, check?: boolean})|null}
 */
function nextMatchFor(announced, wanted, seenPerName) {
  for (const field of wanted) {
    if (field.done) continue;
    if (!matchesFieldName(announced, field.field)) continue;
    if (!matchesWithin(announced, field.within)) continue;
    if (field.nth === undefined) return field;
    const seen = (seenPerName.get(field.field) ?? 0) + 1;
    seenPerName.set(field.field, seen);
    if (seen === field.nth) return field;
    // Counted but not ours: a LATER spec for the same name may want this one, so the walk continues
    // rather than consuming the landing.
    return null;
  }
  return null;
}

/**
 * Fill a form as the config declared, then activate the control it named — one declared state, end to end.
 *
 * The submit is SEPARATE from the fill and deliberately so: a fill that bound nothing must not go on to
 * press submit. An empty form submitted looks exactly like a configured form whose names all drifted, and
 * the evidence would then be attributed to a state nobody described — the failure this whole states model
 * exists to remove.
 */
/**
 * @param {{formState: {state: string, submit: string, fields: {field: string, within?: string, nth?: number}[]},
 *   interaction: Record<string, unknown>, deadline: number,
 *   diag: Diag}} args
 */
async function probeConfiguredForm({ formState, interaction, deadline, diag }) {
  const { filled, unbound } = await fillFormState({ formState, interaction, deadline, diag });
  if (filled.length === 0) {
    // Not an error, and not a submit either. It is REPORTED, because "no field the config named exists on
    // this page" is a real answer — a page that changed, a name that drifted, or a control with no
    // accessible name, which is the 4.1.2 finding the addressing scheme turns on.
    diag.mark("configuredForm", { submitted: false, why: "no configured field was found on this page", unbound });
    interaction.formFill = { ...(interaction.formFill || {}), submitted: false };
    return;
  }
  await anchorToTop();
  for (let step = 0; step < MAX_FILL_STOPS; step += 1) {
    if (Date.now() > deadline) { diag.mark("configuredForm", { submitted: false, why: "deadline" }); return; }
    const announced = await advanceToNextField("configuredSubmit");
    if (!announced) break;
    if (!matchesFieldName(announced, formState.submit)) continue;
    // The SAME delta machinery the opportunistic probe uses, so a configured submission and an
    // opportunistic one produce evidence of identical shape. Two spellings of "what happened after
    // submit" is the fact-stated-twice defect, and a rule reading one would silently ignore the other.
    await activateAndCaptureDelta(announced, interaction, "submit");
    diag.mark("configuredForm", { submitted: true, via: formState.submit, filled: filled.length, unbound });
    interaction.formFill = { ...(interaction.formFill || {}), submitted: true };
    return;
  }
  diag.mark("configuredForm", { submitted: false, why: "the named submit control was not found", submit: formState.submit });
  interaction.formFill = { ...(interaction.formFill || {}), submitted: false };
}

/**
 * How many form fields to walk while filling. The sweep's own cap, for the same reason.
 *
 * A page with a hundred fields is real, and a bound that is too small silently fills SOME of a form —
 * which submits a half-filled form and reports whatever that produced, an answer worse than refusing.
 */
const MAX_FILL_STOPS = 150;

/**
 * Put ONE control into the state the config asked for.
 *
 * Focus mode is entered for the keystrokes and browse mode restored afterwards, every time, and that is
 * not defensive tidying: focus mode makes NVDA's single-letter quick-nav keys TYPE THEMSELVES INTO THE
 * PAGE, which ran for 2,122 captures with every check green. `restoreBrowseMode` is the proven route out.
 *
 * @param {{action: string, text?: string, option?: string, to?: boolean}} fill
 */
/**
 * @param {{action: string, text?: string, option?: string, to?: boolean}} fill
 * @param {string} label
 * @param {Diag} diag
 */
async function applyFill(fill, label, diag) {
  const K = nvda.keyboardCommands;
  await withTimeout(nvda.perform(K.toggleBetweenBrowseAndFocusMode), NAV_TIMEOUT_MS, label)
    .catch(() => undefined);
  try {
    if (fill.action === "type") {
      // Select-all first, because a field may carry a value already — a browser-restored entry, or one
      // this run typed in an earlier state. Appending to it would submit something the config does not
      // describe, and an EMPTY value is the whole point of an error state: "clear this field" is how a
      // validation error is produced, and it cannot be expressed by typing nothing into a full field.
      await withTimeout(nvda.press("Control+a"), NAV_TIMEOUT_MS, label).catch(() => undefined);
      await withTimeout(nvda.press("Delete"), NAV_TIMEOUT_MS, label).catch(() => undefined);
      if (fill.text !== "") {
        await withTimeout(nvda.type(String(fill.text)), NAV_TIMEOUT_MS, label).catch(() => undefined);
      }
    } else if (fill.action === "toggle") {
      // Space toggles a checkbox and selects a radio. The config says which STATE it wants, and the
      // control announces the state it is in, so `toggleIfNeeded` reads it rather than pressing blindly —
      // pressing Space on a checkbox already checked turns it OFF, and the config would then describe the
      // opposite of what was submitted.
      await toggleIfNeeded(Boolean(fill.to), label, diag);
    } else if (fill.action === "choose") {
      // Typing the option's first characters is how a combo box is driven from the keyboard, and it is
      // what a keyboard user does. Arrowing blindly would depend on the option ORDER, which is a fact
      // about the page rather than about the config.
      await withTimeout(nvda.type(String(fill.option)), NAV_TIMEOUT_MS, label).catch(() => undefined);
      await withTimeout(nvda.press("Enter"), NAV_TIMEOUT_MS, label).catch(() => undefined);
    }
  } finally {
    // ALWAYS, even when the keystrokes threw. A capture left in focus mode types its own sweep commands
    // into the page, and that is the most expensive defect this project has had.
    await restoreBrowseMode(label, diag);
  }
}

/**
 * Press Space only when the control is not already in the state we want.
 *
 * NVDA announces `checked` / `not checked` as a state on the control, so the current value is readable and
 * a blind press is unnecessary. It is also wrong: pressing Space on an already-checked box unchecks it, so
 * a config asking for `check: true` would submit `false` and the report would describe a form that was
 * never filled that way.
 */
/**
 * @param {boolean} want
 * @param {string} label
 * @param {Diag} diag
 */
async function toggleIfNeeded(want, label, diag) {
  const announced = String((await withTimeout(nvda.lastSpokenPhrase(), QUERY_TIMEOUT_MS, label)
    .catch(() => "")) || "");
  // `not checked` must be tested BEFORE `checked`, because it contains it. Getting that order wrong is
  // the same shape as a role list where a shorter role shadows a longer one.
  const isOn = /\bnot (?:checked|selected|pressed)\b/i.test(announced)
    ? false
    : /\b(?:checked|selected|pressed)\b/i.test(announced) ? true : null;
  if (isOn === want) {
    diag.mark("formFillToggle", { skipped: "already in the requested state", want });
    return;
  }
  // `null` means the state was not announced. Press anyway and RECORD the uncertainty, rather than
  // skipping: a control whose state we cannot read is more likely to need the press than not, and the
  // mark is what lets a reader tell that case from a confident one.
  if (isOn === null) diag.mark("formFillToggle", { stateUnreadable: true, announced: announced.slice(0, 60) });
  await withTimeout(nvda.press("Space"), NAV_TIMEOUT_MS, label).catch(() => undefined);
}

/**
 * Quick-navigate to a control of the given kind and put NVDA into focus mode on it.
 *
 * THE STEP I SKIPPED, AND THE CAPTURE SAID SO. `probeArrowNavigation` and `probeTypedFeedback` first read
 * "wherever the focus probe finished", which is wherever the tab ring ENDS — on these pages, a furniture
 * link at the bottom. Measured 2026-09-01: the arrow probe recorded
 * `focusBefore: "Annual review 2019 02, link"` and its arrows navigated the DOCUMENT, identically on both
 * variants; the typing probe recorded `typed: false` because its guard correctly refused a link. The
 * register said this outright — *"route in `moveToNextRadioButton` to land, then raw arrows"* — and it is
 * the part it called the digging.
 *
 * Quick navigation is BROWSE MODE by definition, so landing alone gives a virtual caret and no DOM focus.
 * `toggleBetweenBrowseAndFocusMode` is used rather than Enter because Enter ACTIVATES: on a radio it would
 * select an option, which is a state change this probe is supposed to observe rather than cause.
 *
 * Returns what the control announced, or null if none of that kind is on the page — and those are
 * different answers from "the arrows did nothing", which is why the caller checks it.
 *
 * @param {{ to: any, label: string, interaction: any, diag: Diag }} ctx
 */
async function landOnControl({ to, label, interaction, diag }) {
  const K = nvda.keyboardCommands;
  // From the TOP, because quick navigation searches forward from the caret and cannot reach an element
  // the caret is already on -- the rule `sweepEveryStructuralType` records for landmarks and which is
  // true of every type in both directions.
  await anchorToTop();
  const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label)) || []).length;
  await withTimeout(nvda.perform(to), NAV_TIMEOUT_MS, label).catch(() => undefined);
  const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, label)) || [];
  const landed = log.slice(before).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean).join(" ");
  if (!landed) {
    diag.mark(label + "Landing", { landed: null, why: "no control of this kind on the page" });
    return null;
  }
  // Into focus mode, so the keys that follow reach the APPLICATION rather than NVDA's browse-mode scripts.
  await withTimeout(nvda.perform(K.toggleBetweenBrowseAndFocusMode), NAV_TIMEOUT_MS, label)
    .catch(() => undefined);
  const focused = await reportFocusedControlWithRetry(interaction);
  diag.mark(label + "Landing", { landed: landed.slice(0, 80), focused });
  return focused;
}

/**
 * 3.2.1 On Focus — does merely FOCUSING a control change the page's context?
 *
 * WCAG's failure is a control that navigates, opens a window or moves focus elsewhere the moment it
 * receives focus, with no action from the user. The part a screen reader can observe is the page TITLE,
 * read exactly as `probeRouteChange` reads it for 2.4.2 and as `probeTypedFeedback` now reads it for
 * 3.2.2 — the sibling criterion, on input rather than focus.
 *
 * ONE Tab, deliberately, and not a walk. `probeFocusOrder` already walks the tab order and its channel is
 * a list of strings that 28 files read; adding a title per stop would change that shape for all of them.
 * This asks a different question of the first control instead, which is where a page that does this
 * usually does it — and keeps the cost to two title reads rather than one per stop.
 *
 * The title is read AFTER the focus announcement settles. Reading it immediately races the page's own
 * navigation and returns the OLD title on a page that did change context, which reports conformance for
 * the failure — the same trap `probeTypedFeedback`'s comment records.
 *
 * @param {{ interaction: Record<string, any>, deadline: number, diag: any }} ctx
 */
async function probeFocusContext({ interaction, deadline, diag }) {
  const mark = (/** @type {Record<string, unknown>} */ fields) => diag.mark("focusContext", fields);
  try {
    if (Date.now() > deadline) { mark({ skipped: "deadline" }); return null; }
    await anchorToTop();
    const titleBefore = await reportedTitle(diag);
    // WALK THE TAB ORDER, do not press Tab once.
    //
    // The first version pressed once and every one of its 28 corpus cases came back BLIND. The reason is
    // this file's own most-repeated lesson: the FIRST focusable thing on a page is almost never the
    // control you mean. `page()` gives every corpus page furniture — a skip link, a nav list — so one Tab
    // lands there and the field's `focus` handler never runs. `capture-real-pages` records the same fact
    // about `probeNavigation`: "on essentially every real page the first link IS the skip link".
    //
    // Walking is also the truer reading of the criterion. 3.2.1 is about ANY control that changes context
    // on focus, not about the first one, so stopping at one stop would under-report by construction.
    let control = "";
    let titleAfter = titleBefore;
    let stops = 0;
    for (; stops < FOCUS_CONTEXT_STOPS; stops += 1) {
      await withTimeout(nvda.press("Tab"), NAV_TIMEOUT_MS, "focusContext").catch(() => undefined);
      const focused = await reportFocusedControl();
      if (!focused) break;
      control = focused;
      titleAfter = await reportedTitle(diag);
      // Stop at the FIRST change. Carrying on would report the last control rather than the one that
      // moved the user, and the evidence has to name which control did it.
      if (titleAfter !== titleBefore) break;
    }
    if (!control) {
      // NOTHING FOCUSABLE is not "the context did not change" — nothing was focused, so the question was
      // never asked. Nulls, for the reason every absence in this file is a null rather than an empty
      // string: an empty title reads as a title that stayed the same, which is the conformant answer.
      mark({ focused: false, why: "nothing focusable on this page" });
      return { focused: false, control: "", titleBefore: null, titleAfter: null };
    }
    mark({ focused: true, control, stops, titleBefore, titleAfter });
    return { focused: true, control, titleBefore, titleAfter };
  } catch (e) {
    // A probe that threw and a page that changed nothing are opposite findings, and this file has paid a
    // corpus for making them the same silence.
    mark({ error: errMsg(e) });
    interaction.sweepLog.push(`focusContext ERROR ${errMsg(e)}`);
    return null;
  } finally {
    await restoreBrowseMode("focusContext", diag);
  }
}

/**
 * Type into the focused field and record what the page said BEYOND NVDA's own echo.
 *
 * The half of 3.3.1 a capture could not reach. Every existing record describes an error surfaced by
 * SUBMITTING, because that is the only moment this pipeline observed; validation that fires while typing
 * arrives with focus unmoved and only a live region can carry it, so a page can pass the first and fail
 * the second. Measured: `oninput` appears on 0 of 3,948 corpus pages against `onsubmit` on 346.
 *
 * REFUSES TO TYPE UNLESS FOCUS IS IN AN EDITABLE, and that guard is doing two jobs. It keeps the probe
 * from sending characters into whatever the focus probe happened to finish on -- a button, a link, someone
 * else's page -- and it keeps the evidence honest, because `typed: false` says "we could not ask" where a
 * bare empty `announced` would read as "the page said nothing", which IS the finding.
 *
 * THE ECHO IS SEPARATED FROM THE ANNOUNCEMENT, and without that the probe reports nothing useful. NVDA
 * echoes typed characters by default, so a silent page still produces speech; counting the echo as
 * feedback would make every page pass. `echoed` is kept rather than discarded so a future reader can see
 * the probe worked at all -- the `refreshBrowseBuffer` rule, which was inert through three green runs
 * because nothing distinguished "did not need to act" from "never ran".
 *
 * SIX DIGITS, deliberately: enough to trip a length rule, all keyboard-safe, and no character that any
 * quick-navigation script binds. It is typed as one string via guidepup's `type`, not as six `press`
 * calls, so a page debouncing on `input` sees a realistic burst.
 *
 * @param {{ interaction: any, deadline: number, diag: Diag }} ctx
 */
async function probeTypedFeedback({ interaction, deadline, diag }) {
  const mark = (/** @type {Record<string, unknown>} */ fields) => diag.mark("typedFeedback", fields);
  try {
    if (Date.now() > deadline) { mark({ skipped: "deadline" }); return null; }
    const focusBefore = await landOnControl({
      to: nvda.keyboardCommands.moveToNextEditField, label: "typing", interaction, diag,
    });
    if (!focusBefore) {
      mark({ typed: false, why: "no edit field on this page" });
      // NULL, not "", for the titles: this probe never ran, and an empty string would read as a title
      // that did not change -- which is the conformant answer to a question nobody asked.
      return { typed: false, focusBefore: "", echoed: "", announced: "", titleBefore: null, titleAfter: null };
    }
    // The role test is on the ANNOUNCEMENT, because that is the only thing this layer has. NVDA says
    // "edit" for a text input and "edit, multi line" for a textarea; both are places typing belongs.
    if (!/\bedit\b/i.test(String(focusBefore ?? ""))) {
      mark({ typed: false, why: "focus is not in an editable control", focusBefore });
      return { typed: false, focusBefore, echoed: "", announced: "", titleBefore: null, titleAfter: null };
    }
    // 3.2.2 On Input: the page's TITLE either side of the keystrokes. A change of context is the thing
    // that criterion is about, and the title is the part of it a screen reader can see -- NVDA reports it
    // on demand and `probeRouteChange` already reads it the same way for 2.4.2.
    //
    // Read HERE rather than at the top of the probe, so it brackets the typing and nothing else: the
    // landing above navigates, and a title read before that would be measuring the navigation too.
    const titleBefore = await reportedTitle(diag);
    const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "typing")) || []).length;
    await withTimeout(nvda.type(TYPED_PROBE_TEXT), NAV_TIMEOUT_MS, "typing").catch(() => undefined);
    // WAIT FOR SPEECH TO SETTLE, do not read the log the instant `type` returns. The first version did,
    // and the consequence is the exact defect this file has a section about: a live region that DID
    // announce arrived after the read, so `announced` was empty and the page looked silent -- which IS
    // the 3.3.1 finding. A fixed wait would be the same mistake with a timer on it.
    //
    // `waitForAnnouncement` waits for something to be said and THEN for the rest of it to arrive, which
    // matters more here than anywhere else: NVDA echoes six characters first, so the page's own
    // announcement is necessarily behind them in the queue.
    const log = await waitForAnnouncement(before, "typing");
    const spoken = log.slice(before).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean);
    // A phrase is ECHO when it is one of the characters we sent, and ANNOUNCEMENT otherwise. Compared
    // against the string actually typed rather than against a character class, so a page that legitimately
    // speaks a digit is not silently written off as an echo.
    const sent = new Set(TYPED_PROBE_TEXT.split(""));
    const echoed = spoken.filter((/** @type {string} */ phrase) => sent.has(phrase));
    const announced = spoken.filter((/** @type {string} */ phrase) => !sent.has(phrase)).join(" | ");
    // AFTER the speech has settled, or the title read races the page's own announcement and returns the
    // OLD title on a page that did change context -- reporting conformance for the failure.
    const titleAfter = await reportedTitle(diag);
    mark({ typed: true, echoed: echoed.length, announced: announced.slice(0, 120), focusBefore,
      titleBefore, titleAfter });
    return { typed: true, focusBefore, echoed: echoed.join(" "), announced, titleBefore, titleAfter };
  } catch (e) {
    // RECORDED, never dropped. A probe that threw and a page that said nothing while being typed into are
    // opposite findings, and this file has already paid a corpus for making them the same silence.
    mark({ error: errMsg(e) });
    interaction.sweepLog.push(`typedFeedback ERROR ${errMsg(e)}`);
    return null;
  } finally {
    // ALWAYS, even on the throw path. A probe that borrowed focus mode and died still owes it back, and
    // the sweep that runs next cannot tell the difference.
    await restoreBrowseMode("typing", diag);
  }
}

/**
 * Press an arrow inside whatever the focus probe last landed on, and record whether anything moved.
 *
 * THE OBSERVATION 2.1.1 ABSTAINS WITHOUT. `SHARES_ONE_TAB_STOP` refuses to decide on a radio group, tab
 * list or menu because a native one and a broken one both present ONE tab stop -- the tab ring cannot
 * separate them, and that refusal is correct. Pressing the arrow is the only thing that can.
 *
 * RIDES THE FOCUS PROBE, for the reason the dialog probe cost three captures to establish: a sweep is
 * BROWSE MODE and never moves DOM focus, and in browse mode an arrow key navigates the DOCUMENT rather
 * than the widget. An arrow pressed without focus inside the group measures the page, not the group.
 *
 * DOWN THEN RIGHT, and both are needed. NVDA and the browser map a radio group to Down/Up, a horizontal
 * tab list to Right/Left, and a menu to either -- so one key alone would report a working horizontal
 * widget as inert. Pressing both and taking the union answers "did ANY arrow move it", which is the
 * question 2.1.1 asks; distinguishing which axis works is a finer claim than the criterion needs.
 *
 * NO ESCAPE TOLL HERE, and that asymmetry with `probeDialogEscape` is deliberate rather than an oversight.
 * NVDA consumes the first ESCAPE to leave focus mode because Escape is flagged
 * `ignoreTreeInterceptorPassThrough`; arrows carry no such flag, so in focus mode they reach the
 * application directly. The focus probe has already put NVDA in focus mode by landing on the widget.
 *
 * @param {{ interaction: any, deadline: number, diag: Diag }} ctx
 */
async function probeArrowNavigation({ interaction, deadline, diag }) {
  const mark = (/** @type {Record<string, unknown>} */ fields) => diag.mark("arrowNavigation", fields);
  try {
    if (Date.now() > deadline) { mark({ skipped: "deadline" }); return null; }
    const focusBefore = await landOnControl({
      to: nvda.keyboardCommands.moveToNextRadioButton, label: "arrowNav", interaction, diag,
    });
    if (!focusBefore) { mark({ landed: false, why: "no radio button on this page" }); return null; }
    const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "arrowNav")) || []).length;
    for (const key of ["Down", "Right"]) {
      await withTimeout(nvda.press(key), NAV_TIMEOUT_MS, "arrowNav").catch(() => undefined);
    }
    // Settled rather than read immediately. This one HAPPENED to work reading the log straight away --
    // arrow navigation echoes at once -- and happening to work is not the same as being right. A silent
    // result here is the 2.1.1 finding, so a read that outran the speech would manufacture one.
    const log = await waitForAnnouncement(before, "arrowNav");
    const announced = log.slice(before).map((/** @type {unknown} */ x) => String(x).trim())
      .filter(Boolean).join(" | ");
    const focusAfter = await reportFocusedControlWithRetry(interaction);
    mark({ focusBefore, announced: announced.slice(0, 120), focusAfter });
    return { focusBefore, announced, focusAfter };
  } catch (e) {
    // RECORDED, never dropped. A probe that threw and a widget whose arrows do nothing are different
    // findings, and this file has already paid a corpus for making them the same silence.
    mark({ error: errMsg(e) });
    interaction.sweepLog.push(`arrowNavigation ERROR ${errMsg(e)}`);
    return null;
  } finally {
    // ALWAYS, even on the throw path. A probe that borrowed focus mode and died still owes it back, and
    // the sweep that runs next cannot tell the difference.
    await restoreBrowseMode("arrowNav", diag);
  }
}

/**
 * DOES ESCAPE CLOSE IT, AND WHERE DOES FOCUS GO? — the dialog half of `docs/screenreader-coverage.md`.
 *
 * A modal's accessibility is four questions: does focus enter it, does Escape close it, does focus RETURN
 * to what opened it, and is the background still reachable. This tool observed none of them, and the
 * coverage map named a focus trap here as "the classic blocker".
 *
 * PURELY OBSERVATIONAL, and that is what makes it safe to add. It activates nothing of its own: it runs
 * immediately after the sweep, when a control has already been activated by `probeDisclosure` or
 * `probeForms`, and asks what state that left behind. A probe that opened its own dialog would be pressing
 * buttons on a stranger's site for a second time in one capture, and `SECURITY.md` is explicit that
 * pressing *Book* is not a review.
 *
 * ORDER IS LOAD-BEARING, again. `anchorToTop` presses Escape as its FIRST action, so anything that anchors
 * before this runs has already dismissed whatever a dialog probe exists to find — the same coupling that
 * refuted three 2.1.2 rules. It therefore runs inside `runSweep`, before `rescanFormFieldsAfterSubmit`
 * anchors, and never after the focus walk.
 *
 * `focusReturned` is NOT computed here. Whether "back where it started" means the same control is a
 * judgement about announcements, and `parseAnnouncement` is the single grammar for that — TypeScript this
 * plain-node worker cannot import. The three readings are recorded and the comparison belongs to a rule,
 * which is the same split `sweepCompleteness` already makes.
 *
 * @param {{ interaction: any, deadline: number, diag: Diag }} ctx
 */
async function probeDialogEscape({ interaction, deadline, diag }) {
  const mark = (/** @type {Record<string, unknown>} */ fields) => diag.mark("dialogEscape", fields);
  try {
    if (Date.now() > deadline) { mark({ skipped: "deadline" }); return null; }
    const focusBefore = await reportFocusedControlWithRetry(interaction);
    // `press`, never `perform(exitFocusMode)`. Both are Escape on paper and only `press` worked, measured
    // -- `anchorToTop` has used it for this since before anyone understood why.
    const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "dialogEscape")) || []).length;
    // TWICE, and the second press is the one that asks the question.
    //
    // The focus probe leaves NVDA in FOCUS MODE -- `autoPassThroughOnFocusChange` is true by default and
    // `shouldPassThrough` returns True for State.EDITABLE, so tabbing into a dialog's text field switches
    // it on. Escape is flagged `ignoreTreeInterceptorPassThrough` precisely so it stays reachable there,
    // which means NVDA CONSUMES it to leave focus mode and the page never sees it.
    //
    // Measured, and this is the pair of observations that establishes it rather than an inference from
    // the source: with a document-level handler, `anchorToTop`'s Escape (browse mode, focus on the body)
    // DID reach the page and released the trap; the same handler scoped to the dialog, pressed here after
    // the focus probe, did not fire at all. Same page, same handler, two modes, two outcomes.
    //
    // So the first press pays NVDA's toll and the second reaches the application. A page that responds to
    // neither has genuinely ignored Escape.
    await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "dialogEscape").catch(() => undefined);
    await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "dialogEscape").catch(() => undefined);
    const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "dialogEscape")) || [];
    const announced = log.slice(before).map((/** @type {unknown} */ x) => String(x).trim())
      .filter(Boolean).join(" | ");
    const focusAfter = await reportFocusedControlWithRetry(interaction);
    mark({ focusBefore, announced: announced.slice(0, 120), focusAfter });
    return { focusBefore, announced, focusAfter };
  } catch (e) {
    // RECORDED, never dropped. A probe that threw and a page where Escape did nothing are different
    // findings, and this file has already paid once for making them the same silence.
    mark({ error: errMsg(e) });
    interaction.sweepLog.push(`dialogEscape ERROR ${errMsg(e)}`);
    return null;
  }
}

/**
 * 1.4.13 Content on Hover or Focus — does focusing a control REVEAL content, and can Escape dismiss it
 * without moving focus?
 *
 * THREE CENSUSES AND TWO FOCUS READS. The criterion covers "pointer hover OR KEYBOARD FOCUS", and we drive
 * keyboard focus — which is why it stopped being `out-of-scope` on 2026-09-05. The Dismissable bullet asks
 * for a mechanism to dismiss "WITHOUT MOVING pointer hover or keyboard focus", so focus is read either
 * side: a page where Escape navigates has not shown that mechanism, whatever happened to the content.
 *
 * RUNS AFTER `probeFocusOrder` AND IS GATED ON IT, for the reason `probeDialogEscape` records beside it:
 * a sweep is browse mode and never moves DOM focus, so an Escape pressed from wherever the browse caret
 * rests measures the DOCUMENT. This needs a control to actually hold focus.
 *
 * ESCAPE TWICE, the same toll `probeDialogEscape` pays: `autoPassThroughOnFocusChange` switches focus mode
 * on when focus lands on an editable, Escape is flagged `ignoreTreeInterceptorPassThrough` so it stays
 * reachable there, and NVDA therefore CONSUMES the first press to leave focus mode. The second reaches the
 * page.
 *
 * The VERDICT is `focusRevealVerdict` in capture-pure.mjs, so what three counts mean is decided somewhere
 * it can be tested without NVDA.
 *
 * @param {{ interaction: Record<string, any>, deadline: number, diag: Diag }} ctx
 */
async function probeFocusReveal({ interaction, deadline, diag }) {
  const mark = (/** @type {Record<string, unknown>} */ fields) => diag.mark("focusReveal", fields);
  try {
    if (Date.now() > deadline) { mark({ skipped: "deadline" }); return null; }
    // BEFORE is taken with focus already on a control -- `probeFocusOrder` has run -- so it is the baseline
    // for "what this page shows while something is focused", not for the untouched document. Comparing
    // against the untouched document would count everything the focus probe itself revealed.
    await anchorToTop();
    // BEFORE IS THE UNTOUCHED DOCUMENT, and this is the whole correctness of the probe.
    //
    // It used to be taken here with focus already on a control, because `probeFocusOrder` had run --
    // reasoned at the time as "the baseline for what this page shows WHILE something is focused", to avoid
    // counting what the focus probe itself revealed. Counting exactly that IS the finding, and the
    // inversion cost all 18 of the 1.4.13 cases. Measured 2026-09-05, from the tab ring of
    // `focus-panel-undismissable-fee.bad`: stop 2 is the trigger and stop 3 is the link inside the
    // `hidden` panel, so the panel was already open before this probe took its first census, and the
    // delta was zero by construction.
    const before = await structuralCensus();
    // WALK THE TAB ORDER, do not press Tab once — `probeFocusContext` twenty lines up learned this the
    // same way: "the first version pressed once and every one of its 28 corpus cases came back BLIND ...
    // the FIRST focusable thing on a page is almost never the control you mean." `page()` gives every
    // corpus page furniture, and a real page's first stop is the skip link. Walking is also the truer
    // reading: 1.4.13 is about ANY control that reveals content on focus, not about the first one.
    let onFocus = null;
    let focusBefore = null;
    let tabs = 0;
    for (let stop = 0; stop < FOCUS_REVEAL_STOPS; stop += 1) {
      if (Date.now() > deadline) break;
      await withTimeout(nvda.press("Tab"), NAV_TIMEOUT_MS, "focusReveal").catch(() => undefined);
      tabs += 1;
      if (!await reportFocusedControl()) break;
      onFocus = await structuralCensus();
      const grew = censusGrowth(before, onFocus);
      // Stop at the FIRST control that reveals something: the evidence has to name which one did it, and
      // walking on would report the last control rather than the one that mattered.
      if (grew && grew.length > 0) { focusBefore = await reportFocusedControlWithRetry(interaction); break; }
    }
    if (!onFocus) {
      // NOTHING FOCUSABLE is not "nothing appeared" — the question was never asked. Kept apart for the
      // same reason every absence in this file is, and `tabs` says which of the two it was.
      mark({ asked: true, revealed: null, tabs, why: "nothing focusable on this page" });
      return { asked: true, revealed: null, why: "nothing focusable on this page" };
    }
    await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "focusReveal").catch(() => undefined);
    await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "focusReveal").catch(() => undefined);
    const afterEscape = await structuralCensus();
    const focusAfter = await reportFocusedControlWithRetry(interaction);
    const verdict = focusRevealVerdict({ before, onFocus, afterEscape, focusBefore, focusAfter });
    // `tabs` is on the MARK and not in the verdict: "nothing revealed in 8 stops" and "we got one stop
    // before the deadline" are different findings, and the verdict cannot tell them apart.
    mark({ ...verdict, tabs });
    return verdict;
  } catch (e) {
    // RECORDED, never dropped -- a probe that threw and a page that revealed nothing are different
    // findings, and this file has paid for making them the same silence.
    mark({ error: errMsg(e) });
    interaction.sweepLog.push(`focusReveal ERROR ${errMsg(e)}`);
    return null;
  } finally {
    // IT NOW PRESSES TAB UP TO EIGHT TIMES AND LANDS ON EDITABLES, where NVDA switches to focus mode --
    // after which single letters are TYPED INTO THE PAGE instead of navigating. The one-Tab version could
    // mostly get away with omitting this; a walk cannot. Same remedy `probeFocusContext` ends with.
    await restoreBrowseMode("focusReveal", diag);
  }
}

/** @param {{ interaction: Record<string, any>, deadline: number, diag: Diag }} ctx */
async function probeRouteChange({ interaction, deadline, diag }) {
  const mark = (/** @type {Record<string, unknown>} */ fields) => diag.mark("routeChange", fields);
  try {
    if (Date.now() > deadline) { mark({ skipped: "deadline" }); return null; }
    const headingBefore = await firstHeadingFromTop("routeChangeHeadingBefore");
    await anchorToTop();
    const titleBefore = await reportedTitle(diag);

    // Quick-nav to the first link, and prove we MOVED by a log delta rather than by a changed phrase.
    // `sweepInDirection` records why: silence is unambiguous evidence of not moving, while an unchanged
    // phrase is ambiguous between "did not move" and "moved to something announced the same way".
    const before = ((await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "routeChange")) || []).length;
    await withTimeout(nvda.perform(nvda.keyboardCommands.moveToNextLink), NAV_TIMEOUT_MS, "routeChange")
      .catch(() => undefined);
    const log = (await withTimeout(nvda.spokenPhraseLog(), QUERY_TIMEOUT_MS, "routeChange")) || [];
    const control = log.slice(before).map((/** @type {unknown} */ x) => String(x).trim()).filter(Boolean).join(" | ");
    const reachedNothing = noLinkReached(control);
    if (reachedNothing) {
      mark({ found: false, reason: reachedNothing });
      interaction.sweepLog.push(`routeChange ${reachedNothing}`);
      return { control: null, titleBefore, titleAfter: titleBefore, headingBefore, headingAfter: headingBefore, nextFocusAfter: null, announced: "", navigated: false };
    }
    // WHAT WAS PRESSED, recorded before pressing it. These are live sites belonging to other people, and
    // `probeNavigation` is defensible because following a link is ordinary browsing — the thing this tool
    // already did to reach the page. Naming the target makes that reviewable after the fact instead of
    // taken on trust, and it is the field to read first if a capture ever does something surprising.
    mark({ activating: control.slice(0, 120) });

    const activation = await activateAndCaptureDelta(control, interaction, "route");
    // FIRST, before anything moves the caret. This reading is where focus went as a RESULT of the
    // activation, and every other measurement below rewinds to the top of the document to take its own —
    // `firstHeadingFromTop` and `reportedTitle` both anchor. Taken afterwards it recorded the first link on
    // the page for every variant of every case, identically, which reads as "the skip link did nothing" on
    // a page where it worked perfectly.
    const nextFocusAfter = await focusedAfterTab("routeChangeFocusAfter");
    const titleAfter = await reportedTitle(diag);
    // The FIRST HEADING, before and after, and it is the signal that makes this probe sound.
    //
    // The obvious corroboration -- "was anything announced?" -- is wrong, and the corpus said so on the
    // first capture: the failing page announced `"visited"`, NVDA reporting the link's own state. Not
    // silence, and it names nothing about where the user now is, so a rule keyed on silence would never
    // fire on the very page it was written for.
    //
    // What actually distinguishes the failure is whether the VIEW MOVED while the title stood still. It
    // also disposes of this probe's real false-positive risk: if the first link was a skip link or a plain
    // fragment jump, the heading does not change either, and the rule correctly makes no claim.
    const headingAfter = await firstHeadingFromTop("routeChangeHeadingAfter");
    const result = {
      control,
      titleBefore,
      titleAfter,
      headingBefore,
      headingAfter,
      // WHERE THE NEXT TAB LANDS, which is the only way to tell a working bypass link from a decorative one.
      //
      // 2.4.1 does not require a skip link — headings or landmarks satisfy it, so its ABSENCE is not a
      // failure and detecting absence would over-claim. What a static checker cannot see is a skip link that
      // is PRESENT and inert: it reads a link and a plausible `href` and passes the page. Activating it and
      // asking where focus went afterwards is the whole difference, and only a real browser driven by a real
      // screen reader can answer it.
      //
      nextFocusAfter,
      announced: activation?.after ?? "",
      navigated: true,
    };
    mark({
      found: true,
      titleChanged: titleBefore !== titleAfter,
      viewChanged: headingBefore !== headingAfter,
      announcedChars: result.announced.length,
    });
    return result;
  } catch (e) {
    // A failed measurement is not a silent page. An empty `announced` with an unchanged title IS the
    // finding here, so an error recorded as that would invert it -- the `probeDisclosure` lesson, which
    // cost 1 in 20 captures of a correctly implemented page.
    mark({ error: errMsg(e) });
    interaction.sweepLog.push(`routeChange ERROR ${errMsg(e)}`);
    return { control: null, titleBefore: null, titleAfter: null, headingBefore: null, headingAfter: null, nextFocusAfter: null, announced: null, error: errMsg(e) };
  }
}

// Submit the form with no valid input to test error handling. An accessible form
// announces the error (3.3.1) via a status message (4.1.3); an inaccessible one
// shows it visually and the screen reader hears nothing.
/** @param {string} phrase @param {Record<string, any>} ctx */
async function probeFormSubmit(phrase, { interaction }) {
  // Record whether submitting NAVIGATED, because that changes what the absence of an error means.
  //
  // A form that stays put and says nothing has failed 3.3.1. A form that submits successfully and moves
  // to another page has not — there is no error to announce. Both look identical to a probe that only
  // asks "was anything announced afterwards?", and on a real site the second is the common case:
  // submitting Wikipedia's search navigated away, the post-submit re-read described French Wikipedia, and
  // that was reported as a silent validation error on a form that worked.
  //
  // Every page in this corpus calls `preventDefault()`, which is why this never surfaced until the probe
  // met the open web.
  const before = await currentPageUrl();
  const result = await activateAndCaptureDelta(phrase, interaction, "submit");
  const after = await currentPageUrl();
  if (before && after && before !== after) {
    interaction.navigatedOnSubmit = { from: before, to: after };
  }
  // What the page SHOWS after submitting, from the accessibility tree.
  //
  // This is the oracle 3.3.1 and 4.1.3 were missing, and without it neither can be judged honestly.
  // "The form rejected my input and said nothing" and "the form accepted my input" produce the same
  // screen-reader evidence — silence — so the criterion was being decided by what our probe happened to
  // do rather than by what the page did. The visual side settles it: an error message or a result count
  // present in the tree and absent from the announcements is the failure, and one present in neither is
  // simply a form that worked.
  //
  // Names only, never counts, and it stays a diagnostic-grade oracle rather than evidence, exactly as
  // `structureCensus` does — `docs/local-model.md` bars the accessibility tree as a model feature.
  // The census can answer `{ error }`, which carries no names. `censusShape`'s lesson one field along:
  // an errored census is not a reading, and `?? []` on a missing property would silently agree with a
  // page that genuinely announced nothing.
  const postSubmitCensus = await structuralCensus();
  interaction.postSubmitNames = postSubmitCensus && !("error" in postSubmitCensus)
    ? postSubmitCensus.names
    : [];
  return result;
}

// Activate a non-submit button the task explicitly names (e.g. a filter "Bags"
// for the task "show only bags") and capture what is announced. A page that
// updates results in a live region announces the new state (4.1.3); one that
// updates silently announces nothing.
/** @param {string} phrase @param {Record<string, any>} ctx */
async function probeTaskButton(phrase, { interaction }) {
  return activateAndCaptureDelta(phrase, interaction, "taskButton");
}

/**
 * Toggle a checkbox or radio button and record what the page announced — 4.1.3's other trigger.
 *
 * A live region updated by a CHECKBOX was structurally unreachable before this: `probeKindFor` only ever
 * reached buttons, and real filters, consent toggles and "show prices including VAT" controls are
 * checkboxes far more often than they are buttons. The safety decision is in `SECURITY.md` and the gate is
 * `probeKindFor`; this is only the dispatch, exactly as `probeTaskButton` is.
 *
 * `kind: "toggle"` is a NEW value on `formChanges` entries, and it is additive on purpose. `screenreader_
 * features.py` gates `validation_error_missing` on `kind === "submit"`, so a toggle simply does not match
 * it -- which is right, since a toggled checkbox is not a rejected submission and 3.3.1 must not read one
 * as the other. That distinction is what `kind` was added for: it cost 3 false positives when a combo box
 * counted as a submit, and 12 more when the state-change rule reproduced it.
 */
/** @param {string} phrase @param {Record<string, any>} ctx */
async function probeToggle(phrase, { interaction }) {
  return activateAndCaptureDelta(phrase, interaction, "toggle");
}

// --- Teardown phase -------------------------------------------------------

// Stop NVDA and close the browser so the next capture starts fresh.
/**
 * @param {Diag} diag @param {any} browser
 * @param {{ keepScreenReader?: boolean, reuseBrowser?: boolean }} options
 */
async function stopAndCleanup(diag, browser, { keepScreenReader, reuseBrowser = REUSE_BROWSER }) {
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
