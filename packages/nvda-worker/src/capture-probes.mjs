// @ts-check
/**
 * capture-probes.mjs — walk a live page by structural type and run the ~30 probes that observe how it
 * responds to interaction.
 *
 * Split out of `capture-core.mjs`'s "Structural navigation + interaction phase" section, moved as ONE
 * unit rather than by individual probe: several probes here reference each other's lessons directly in
 * their own comments (`probeFocusContext`, `probeTypedFeedback`, `probeArrowNavigation`,
 * `probeDialogEscape` and `probeFocusReveal`/`walkToReveal` all cite a sibling's retry pattern, escape
 * handling, or walk-not-single-press fix), and separating them would make that cross-reference invisible
 * to whoever edits one next — the same shape CLAUDE.md records four times over for this file. `probeOrder`
 * and the sequencing in `probePasses`/`navigateByStructure` are equally load-bearing and untouched; this
 * is a movement of code, not a reordering.
 *
 * Depends on `capture-setup.mjs` for the handful of primitives the browser/NVDA lifecycle also needs
 * (`withTimeout`, `errMsg`, `anchorToTop`, `waitForSpeechQuiet`, `refreshBrowseBuffer`, `reportedTitle`)
 * — imported rather than duplicated, so there is still exactly one definition of each. `capture-core.mjs`
 * calls back in at exactly one place, `navigateByStructureThenAudit`, to run this whole phase; nothing
 * here calls back into `capture-core.mjs`.
 */
import { nvda } from "@guidepup/guidepup";
import {
  crossCheckStructure, dedupeKey, elementsListRowName, MIN_CONTROL_NAME_LEN, probeKindFor,
  sweepStepFromSpeech, focusOrderCycled, sweepObservation, notObserved, recordWhatWasAsked,
  focusRevealVerdict, focusEventVerdict, censusGrowth,
} from "./capture-pure.mjs";
import {
  currentPageUrl, mediaCensus, structuralCensus, domCensus, truncatedAnnouncements,
  installFocusEventLog, collectFocusEventLog,
} from "./browser-session.mjs";
import { matchesFieldName, matchesWithin, fillActionFor } from "./field-match.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  withTimeout, errMsg, anchorToTop, waitForSpeechQuiet, refreshBrowseBuffer, reportedTitle,
  NAV_TIMEOUT_MS, QUERY_TIMEOUT_MS, STATE_POLL_MS,
} from "./capture-setup.mjs";

/**
 * @typedef {import("./capture-pure.mjs").CaptureDiagnostics} Diag
 *   The mark log, threaded through almost every function here. Aliased rather than re-described: this
 *   file passes it to forty of them, and forty inline shapes is forty chances to disagree.
 *
 * @typedef {{ headings: string[], landmarks: string[], formFields: string[], graphics: string[], links: string[], lists: string[], tableCells: string[], frames: string[] }} CapturedStructure
 * @typedef {{ control: string, after: string }} AnnouncedChange
 * @typedef {{ controls: string[], stateChanges: AnnouncedChange[], formChanges: AnnouncedChange[], postSubmitFields: string[], focusOrder: string[], routeChange?: unknown, navigatedOnSubmit?: unknown, postSubmitNames?: string[] }} CapturedInteraction
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
// Full history of every bump (2 -> 14) and why: docs/capture-protocol-version-history.md. The
// pattern that repeats: additive alone does not excuse skipping a bump if the SAME page can now
// produce DIFFERENT evidence than before, and bundling an evidence change with a recapture already
// in flight is how this file's own rule pays for the fleet time once rather than twice.
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
export async function navigateByStructureThenAudit(options) {
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
      // The exact counts `crossCheckStructure` reads, named explicitly rather than spreading `census`
      // wholesale -- `census` also carries `graphicUnnamedDetail` (an array), `names` (strings) and now
      // `targetMatch` (a string), none of which fit `Record<string, number | undefined>`, and none of
      // which this comparison is about.
      elementsList: { heading: census.heading, landmark: census.landmark, link: census.link,
        graphic: census.graphic, distinct: census.distinct },
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
 *           arrowNavigation: unknown, typedFeedback: unknown, focusContext: unknown,
 *           focusReveal: unknown, focusEvents: unknown }} ctx
 */
function interactionEvidence({
  structure, interaction, postSubmitFields, focusOrder, routeChange, dialogEscape, arrowNavigation,
  typedFeedback, focusContext, focusReveal, focusEvents,
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
    // 1.4.13. THIS LINE IS WHAT THE DOCSTRING ABOVE WARNS ABOUT, and it was missing for the probe's whole
    // life: the verdict was computed, written to its diagnostic mark, and dropped here, so
    // `interaction.focusReveal` was `undefined` on every capture and the signal reading it was BLIND on all
    // 18 cases. The mark said `revealed: true, dismissed: false` on the bad page and `dismissed: true` on
    // the good one -- the discrimination was real and never reached the channel. Same shape as
    // `postSubmitFields` empty on 2,122 captures, which is the example this function's own docstring gives.
    ...(focusReveal ? { focusReveal } : {}),
    // Absent unless asked for, like every other opt-in field. Absent and "we watched for F55 and never saw
    // it" must stay distinguishable — `focusEventVerdict` already keeps `checked: false` (no oracle) apart
    // from `scriptRemovedFocus: []` (oracle ran, saw nothing); dropping the field HERE would flatten that
    // distinction right back into the single silence this repeated lesson is about.
    ...(focusEvents ? { focusEvents } : {}),
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
   *           arrowNavigation: any, typedFeedback: any, focusContext: any, focusEvents: any}} */
  const results = {
    postSubmitFields: [], focusOrder: [], dialogEscape: null, focusReveal: null, arrowNavigation: null, typedFeedback: null,
    focusContext: null, focusEvents: null,
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
    const { focusOrder, focusEvents } = await probeFocusOrderWithEventLog({
      deadline, diag, probeFocus, controlsOnPage: structure.formFields.length,
    });
    results.focusOrder = focusOrder;
    results.focusEvents = focusEvents;
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
    focusContext, focusReveal, focusEvents } = results;

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
    typedFeedback, focusContext, focusReveal, focusEvents, diag,
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
 *           typedFeedback: unknown, focusContext: unknown, focusReveal: unknown, focusEvents: unknown,
 *           diag: Diag }} ctx
 */
function assembleAndMark({ structure, interaction, postSubmitFields, focusOrder, routeChange, dialogEscape,
  arrowNavigation, typedFeedback, focusContext, focusReveal, focusEvents, diag }) {
  const result = interactionEvidence({
    structure, interaction, postSubmitFields, focusOrder, routeChange, dialogEscape, arrowNavigation,
    typedFeedback, focusContext, focusReveal, focusEvents,
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

/**
 * `probeFocusOrder`, bracketed by the F55 focus-event log — installed immediately before, collected
 * immediately after, whether or not the probe threw.
 *
 * F55 — "using script to remove focus when focus is received" (2.1.1, 2.4.7, 2.4.13 and 3.2.1 all named
 * together in W3C's own listing) — produces a tab-stop list identical to a control that was never
 * focusable, and `probeFocusOrder` is the ONLY probe that moves real focus, so it is the only window in
 * which the DOM's own `focusin`/`focusout` pair can catch it. Bracketing ONLY this probe, rather than the
 * whole capture, bounds how long a page-injected listener runs to the one thing its evidence needs: real
 * Tab presses happening. See `installFocusEventLog`'s comment for the rest of the reasoning.
 *
 * A separate function rather than inlined in `runFocus`, which the extra try/finally pushed over this
 * repo's complexity gate — the same reason `probeFocusOrder` itself is not inlined there.
 *
 * @param {{ deadline: number, diag: Diag, controlsOnPage: number, probeFocus: boolean }} ctx
 */
async function probeFocusOrderWithEventLog({ deadline, diag, controlsOnPage, probeFocus }) {
  if (!probeFocus) return { focusOrder: [], focusEvents: null };
  const install = await installFocusEventLog();
  try {
    const focusOrder = await probeFocusOrder({ deadline, diag, controlsOnPage });
    return { focusOrder, focusEvents: await finishFocusEventLog({ diag, install }) };
  } catch (error) {
    // The probe threw. Its own caller decides whether that fails the capture; this must still tear the
    // listener down and report what it saw before rethrowing, for the identical reason `captureWithNvda`'s
    // `finally` clears `setExpectedPageUrl` unconditionally -- a listener left attached because a LATER
    // step threw is a persistent side effect outliving the capture that hit it.
    await finishFocusEventLog({ diag, install });
    throw error;
  }
}

// Kept equal to `capture-pure.mjs`'s `FOCUS_EVENT_LOG_LIMIT` (raised 50 -> 300 on 2026-09-06, see that
// file's comment) so the diagnostic mark a human reads and the log a rule actually decides from never
// silently disagree about how much of a busy page's focus activity is visible.
const FOCUS_EVENT_LOG_DIAGNOSTIC_LIMIT = 300;

/**
 * Read the focus-event log, tear the listener down, mark what happened, and decide F55 from it — the
 * second half of `probeFocusOrderWithEventLog`, split out only because that function needs to call it from
 * both its success path and its catch, and a `try`/`finally` cannot also report a `throw`'s own error into
 * the same mark cleanly.
 *
 * `installTargetUrl`/`collectTargetUrl`/`expectedUrl` and the bounded `events` array were added
 * 2026-09-05, diagnosing the mechanism's first real capture: `installTargetMatch: "fallback"` on BOTH
 * variants of `focus-removed-on-receipt-coupon`, on synthetic pages whose path should match trivially. A
 * mark that says ONLY "fallback" cannot tell "the listener landed on an unrelated document" from "it
 * landed on the right one anyway, for a reason `sameDocument` does not yet account for" -- two causes
 * needing opposite fixes. `events` reported as a bare count previously; this file's own oldest lesson is
 * that a count is where an investigation stops, and it did: `events: 24` could not say whether the coupon
 * field's own focusin/focusout ever appeared in the log at all.
 *
 * @param {{ diag: Diag, install: { installed: boolean, targetMatch: string | null, targetUrl?: string,
 *           expectedUrl?: string | null, error?: string, already?: boolean } }} ctx
 */
async function finishFocusEventLog({ diag, install }) {
  const collected = await collectFocusEventLog();
  diag.mark("focusEventLog", focusEventLogMark(install, collected));
  return focusEventVerdict(collected);
}

/**
 * The install-side half of the mark, split out purely to keep `focusEventLogMark`'s complexity under gate.
 * @param {{ installed?: boolean, targetMatch?: string | null, targetUrl?: string,
 *           expectedUrl?: string | null, error?: string }} install
 */
function focusEventLogInstallFields(install) {
  return {
    installed: install?.installed ?? false,
    installTargetMatch: install?.targetMatch ?? null,
    installTargetUrl: install?.targetUrl ?? null,
    installError: install?.error ?? null,
  };
}

/**
 * The collect-side half, same reason.
 * @param {{ targetMatch?: string | null, targetUrl?: string, candidates?: number,
 *           events?: Array<{type: string, id: number, name: string, atMs: number}> | null,
 *           expectedUrl?: string | null, error?: string }} collected
 */
function focusEventLogCollectFields(collected) {
  return {
    collectTargetMatch: collected.targetMatch,
    collectTargetUrl: collected.targetUrl ?? null,
    // `candidates` alongside the match status it qualifies -- a bare "fallback" cannot tell "the only page
    // open" from "one of several, chosen by default", and `focusEventVerdict` is what actually acts on it.
    collectCandidates: collected.candidates ?? null,
    eventCount: collected.events?.length ?? null,
    events: collected.events?.slice(0, FOCUS_EVENT_LOG_DIAGNOSTIC_LIMIT) ?? null,
    collectError: collected.error ?? null,
  };
}

/**
 * Split out of `finishFocusEventLog` purely to keep that function's complexity under the repo's gate.
 * @param {Parameters<typeof focusEventLogInstallFields>[0]} install
 * @param {Parameters<typeof focusEventLogCollectFields>[0]} collected
 */
function focusEventLogMark(install, collected) {
  return {
    ...focusEventLogInstallFields(install),
    ...focusEventLogCollectFields(collected),
    expectedUrl: install?.expectedUrl ?? collected.expectedUrl ?? null,
  };
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
      // Retry for the reason its sibling in `probeFocusReveal` does: this is a loop of up to eight pure
      // reads, `reportFocusedControl` throws on a timeout at a measured 1 in 20, and a throw abandons the
      // whole walk rather than one stop. Found 2026-09-05 by review of the reveal probe, which had the
      // identical shape -- a remedy that reached one call site when the behaviour reaches several.
      const focused = await reportFocusedControlWithRetry(interaction);
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
 * Tab through the first few stops and stop at the one that reveals something.
 *
 * A PHASE, not a name restating its code. "Walk until the page changes" is the whole of what
 * `probeFocusReveal` must do before it can ask its question, and separating it lets that function read
 * top-down as baseline -> walk -> dismiss -> judge. Extracted when the PHYSICAL-line budget refused it,
 * which ESLint cannot catch: `skipComments: true` lets a comment-dense function run to twice its
 * 70-line lint budget.
 *
 * @param {{ before: unknown, interaction: Record<string, any>, deadline: number }} ctx
 * @returns {Promise<{onFocus: unknown, revealedAt: number, tabs: number}>}
 */
async function walkToReveal({ before, interaction, deadline }) {
    // WALK THE TAB ORDER, do not press Tab once — `probeFocusContext` twenty lines up learned this the
  // same way: "the first version pressed once and every one of its 28 corpus cases came back BLIND ...
  // the FIRST focusable thing on a page is almost never the control you mean." `page()` gives every
  // corpus page furniture, and a real page's first stop is the skip link. Walking is also the truer
  // reading: 1.4.13 is about ANY control that reveals content on focus, not about the first one.
  let onFocus = null;
  let revealedAt = -1;
  let tabs = 0;
  for (let stop = 0; stop < FOCUS_REVEAL_STOPS; stop += 1) {
    if (Date.now() > deadline) break;
    await withTimeout(nvda.press("Tab"), NAV_TIMEOUT_MS, "focusReveal").catch(() => undefined);
    tabs += 1;
    // WITH RETRY, like every other focus read that decides something. `reportFocusedControl` throws on
    // a timeout at a measured 1 in 20, and this call is inside a loop of up to eight, so the compound
    // rate is nothing like the single read the bare version was sized for -- and a throw here does not
    // lose one stop, it propagates to the outer catch and abandons the WHOLE probe as `{error}` on a
    // page where a later stop might have revealed the panel. The next line already uses the retry
    // wrapper; two reads in one loop disagreeing about it is the defect, not the choice.
    if (!await reportFocusedControlWithRetry(interaction)) break;
    onFocus = await structuralCensus();
    const grew = censusGrowth(before, onFocus);
    // Stop at the FIRST control that reveals something: the evidence has to name which one did it, and
    // walking on would report the last control rather than the one that mattered.
    if (grew && grew.length > 0) { revealedAt = stop; break; }
  }
  return { onFocus, revealedAt, tabs };
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
 * RUNS BEFORE `probeFocusOrder`, AND THIS PARAGRAPH SAID THE OPPOSITE UNTIL 2026-09-05. It did run
 * after, and that is what made all 18 of its cases BLIND: `probeFocusOrder` walks the entire tab ring,
 * so anything revealed on focus was already in this probe's `before` census and the delta was zero by
 * construction.
 *
 * It is still GATED on `probeFocus`, because the gate and the ORDER are different questions and the
 * gate's reason stands: a sweep is browse mode and never moves DOM focus, so an Escape pressed from
 * wherever the browse caret rests measures the DOCUMENT. This probe establishes focus by walking the
 * tab order itself, so it needs no earlier probe to have moved it — which is what makes running first
 * possible at all.
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
    const { onFocus, revealedAt, tabs } = await walkToReveal({ before, interaction, deadline });
    if (!onFocus) {
      // NOTHING FOCUSABLE is not "nothing appeared" — the question was never asked. Kept apart for the
      // same reason every absence in this file is, and `tabs` says which of the two it was.
      mark({ asked: true, revealed: null, tabs, why: "nothing focusable on this page" });
      return { asked: true, revealed: null, why: "nothing focusable on this page" };
    }
    // THE FIRST ESCAPE IS THE TOLL, AND THE BASELINE READ GOES BETWEEN THE TWO.
    //
    // NVDA consumes the first Escape to leave focus mode and the page never sees it, which is why this
    // presses twice. The consequence for the focus READS was missed: taken before any Escape, `focusBefore`
    // is a FOCUS-MODE reading and `focusAfter` a BROWSE-MODE one, so they can never be equal and
    // `focusHeld` was false on every capture. Measured 2026-09-05, and the two strings say it outright:
    //
    //   focusBefore  "B, o, o, k, i, n, g, space, r, e, f, e, r, e, n, c, e"
    //   focusAfter   "Booking reference, edit, focused, blank"
    //
    // Focus had not moved at all. NVDA spells a field's name character by character in focus mode, so this
    // was two alphabets compared as strings -- the U+FFFC and U+E604 lesson a third time. Reading BETWEEN
    // the Escapes puts both in browse mode and leaves the second Escape, the one the page actually sees,
    // as the only thing between them.
    await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "focusReveal").catch(() => undefined);
    const focusBefore = await reportFocusedControlWithRetry(interaction);
    await withTimeout(nvda.press("Escape"), NAV_TIMEOUT_MS, "focusReveal").catch(() => undefined);
    const afterEscape = await structuralCensus();
    const focusAfter = await reportFocusedControlWithRetry(interaction);
    const verdict = focusRevealVerdict({ before, onFocus, afterEscape, focusBefore, focusAfter });
    // `tabs`, `focusBefore` and `focusAfter` are on the MARK and not in the verdict.
    //
    // `tabs` because "nothing revealed in 8 stops" and "we got one stop before the deadline" are different
    // findings and the verdict cannot tell them apart.
    //
    // THE TWO FOCUS STRINGS BECAUSE `focusHeld` IS A BOOLEAN AND A BOOLEAN IS WHERE AN INVESTIGATION
    // STOPS. Measured 2026-09-05: it read `false` on BOTH variants of every 1.4.13 case, which makes the
    // signal — `focusHeld === true && dismissed === false` — unable to fire on the bad page, and makes
    // `vanished` fire on the conformant one. Whether that is focus genuinely moving, or the same control
    // announced differently once Escape has left focus mode, is not decidable from `false`. The strings
    // are the evidence; recording them costs nothing and one capture then answers it.
    mark({ ...verdict, tabs, revealedAt, focusBefore, focusAfter });
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
