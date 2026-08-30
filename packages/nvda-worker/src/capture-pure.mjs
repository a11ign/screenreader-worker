// @ts-check
/**
 * The pure half of the capture path: no guidepup, no NVDA, no browser — just the functions that turn what a
 * screen reader SAID into structure, and the constants they judge it against.
 *
 * ## Why this file exists
 *
 * `@guidepup/guidepup` **throws at import time** where no screen reader exists. CI is Linux, so merely
 * importing `capture-core.mjs` fails there — and six test files did exactly that to reach these pure
 * helpers, so they died with it. Node reports that per FILE, as "test failed", which reads like broken logic
 * rather than an unavailable dependency: the job had been red since 1 August, growing from 2 files to 6 as
 * more tests imported `capture-core` for pure logic.
 *
 * Nothing here may import guidepup, and `./pure-graph.test.ts` enforces that by walking the
 * import graph. `capture-core.mjs` imports these and re-exports them, so every existing caller is unchanged.
 *
 * ## What belongs here
 *
 * A function belongs here when it is a pure function of a transcript, a phrase or a URL. Anything that talks
 * to NVDA, the browser or the filesystem does not — it stays in `capture-core.mjs`, where it can only be
 * tested against real NVDA on the Windows worker.
 *
 * The move was computed rather than eyeballed: the transitive closure of the seven symbols the tests need is
 * exactly these 19 declarations, and it contains no guidepup symbol. An earlier attempt to do this by hand
 * broke `capture-core` — a 2,370-line module with no local test — and was reverted.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { captureFault, FAULT } from "./capture-faults.mjs";

export const MIN_CONTROL_NAME_LEN = 3; // shorter is a stray key echo ("f"), not a control name

// Submit-like button names. Used only when probing forms, because activating a
// submit button has side effects and must be opt-in.
const SUBMIT_RE = /\b(submit|sign ?up|sign ?in|log ?in|send|search|continue|save|register|join|subscribe|book|reserve|request|hire)\b/i;

// Role/state words to ignore when matching a control's NAME against the task, so
// a button is only activated when its actual label appears in the user's task.
const CONTROL_WORDS = new Set([
  "button", "link", "graphic", "image", "edit", "text", "checkbox", "radio", "combo",
  "box", "list", "clickable", "menu", "item", "heading", "level", "not", "checked",
  "pressed", "collapsed", "expanded", "selected", "of", "out",
]);

/**
 * Does the control's own NAME appear in the user's task?
 *
 * The guard that stops a task-driven activation from pressing an arbitrary button: role and state words
 * are excluded, so only a real label can match.
 */
/** @param {string} phrase @param {string} task */
function taskNamesControl(phrase, task) {
  if (!task) return false;
  const taskWords = new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => w.length >= MIN_CONTROL_NAME_LEN && !CONTROL_WORDS.has(w) && taskWords.has(w));
}

export const MAX_REPEATED_PHRASES = 3; // identical lines in a row => bottom of page

export const MAX_WRAP_REPEATS = 4; // already-seen substantial lines in a row => wrapped around

export const SUBSTANTIAL_PHRASE_LEN = 20; // a phrase longer than this is worth deduping on

// Consecutive silent advances that end a read-through NVDA was never going to speak into.
// Only ever consulted when NVDA was ALSO silent at startup -- see readPageInOrder.
export const MAX_SILENT_STEPS = 8;

export const DEDUPE_KEY_LEN = 80; // prefix length used to dedupe announcements

// --- Read-through phase ---------------------------------------------------

// Read the page line by line in document order (browse mode), returning the
// ordered transcript. Stops at the page bottom (repeated lines), on a wrap-around
// (a run of already-seen lines), at the step cap, or at the deadline.
/**
 * What to do with the phrase just heard: `"keep"` it, `"skip"` it, or a stop reason to end the read.
 *
 * Split out of the read loop because that loop was doing two jobs — walking the page, and deciding when
 * the walk is over — and all the subtlety is in the second. Bottom-of-page, wrap-around and silence
 * each look like an ordinary line until you count how many times in a row they happen, so the counters
 * and the rules that read them belong together.
 *
 * `tracker` is mutated: it is the running state of one read-through.
 *
 * **Silence.** An empty read is unremarkable on its own, so this needs TWO signals before concluding
 * NVDA is mute: it said nothing at startup (`silentAtStart`) AND nothing substantive has been heard
 * since. That is the same conjunction `failIfScreenReaderIsMute` uses; this only reaches the conclusion
 * sooner, which is worth ~2 minutes because a mute NVDA otherwise answers all 150 advances with
 * silence and then the read is retried in full.
 *
 * The care is because the cost of being wrong is asymmetric: stopping early on a page that WAS being
 * read would silently shorten a transcript, and short transcripts are exactly the evidence rot this
 * project has been bitten by. When NVDA spoke at startup, the silence branch is unreachable and a
 * read-through behaves precisely as it did before.
 */
/**
 * @param {string} phrase
 * @param {number} heard  how many SUBSTANTIVE phrases the read has produced so far, not a set of them
 * @param {{ silentRun: number, silentAtStart: boolean, previous: string | null,
 *           repeated: number, seen: Set<string>, wrapRun: number }} tracker
 *
 * READ off the body rather than guessed from the call sites. The first attempt at this described a
 * two-field bag and made `heard` a Set, which is the mistake `host-metrics` produced an hour earlier:
 * a shape inferred from how a value is USED describes the uses, not the value.
 */
export function phraseAction(phrase, heard, tracker) {
  if (!phrase) {
    tracker.silentRun += 1;
    const mute = tracker.silentAtStart && heard <= 1 && tracker.silentRun >= MAX_SILENT_STEPS;
    return mute ? "silent" : "skip";
  }
  tracker.silentRun = 0;
  if (phrase === tracker.previous) {
    return ++tracker.repeated >= MAX_REPEATED_PHRASES ? "repeatBottom" : "skip";
  }
  tracker.repeated = 0;
  tracker.previous = phrase;
  const substantial = phrase.length > SUBSTANTIAL_PHRASE_LEN;
  if (substantial && tracker.seen.has(phrase)) {
    return ++tracker.wrapRun >= MAX_WRAP_REPEATS ? "wrap" : "skip";
  }
  tracker.wrapRun = 0;
  if (substantial) tracker.seen.add(phrase);
  return "keep";
}

// A mute NVDA cannot be fixed by reading harder -- stop and say so.
//
// The diagnostics of a degenerate capture name this exactly: `documentReady ok=true` (NVDA answered
// with the title), `afterStart lastSpoken=""` (it has said NOTHING), a read-through of one phrase, and
// then every sweep reporting `found: 0` after three round trips each. NVDA responded to every
// keystroke and never spoke. The runbook already names this state: "NVDA is running but not speaking".
//
// Re-anchoring cannot help, so the retry above wastes a second read, and the sweeps then spend ~45 s
// producing nothing -- 96 s in total for a capture that was never going to yield evidence.
//
// Failing here is also the SAFE way to recover. A failed capture is cleaned up with
// keepScreenReader:false, which stops NVDA, so the next capture cold-starts a fresh one. That reuses
// the existing path rather than adding another place that restarts NVDA -- which is precisely the loop
// that put modal dialogs on the guest desktop and made workers look dead.
// Exported so the gate itself can be tested. It is a pure function of (transcript, diagnostics), and
// the fault code it throws is what the worker's retry keys on — a coupling worth a test rather than a
// comment, because when it breaks nothing fails loudly: the worker just quietly stops recovering.
/**
 * @typedef {{ entries: { event: string, [key: string]: any }[] }} MarkLog
 *   What a READER of the diagnostics needs. Split from the writer below because most helpers here only
 *   read, and `capture-pure.corpus.test.ts` drives them with a bare `{ entries }` -- correctly, since a
 *   test that had to supply a `mark` it never calls would be describing a dependency that is not there.
 *
 * @typedef {MarkLog & { mark: (event: string, detail?: Record<string, unknown>) => void }} CaptureDiagnostics
 *   The log plus its writer, for the one helper that records a finding as well as deciding one.
 *
 *   Named once because five helpers here take it, and this file is where "did not need to act" and
 *   "never ran" are told apart -- a shape restated five times is how those two become one.
 *
 * @param {string[]} transcript
 * @param {CaptureDiagnostics} diag
 */
export function failIfScreenReaderIsMute(transcript, diag) {
  if (transcript.length > 1) return;
  if (!screenReaderWasSilentAtStart(diag)) return; // absent or non-empty: something else is wrong
  diag.mark("screenReaderMute", { transcript: transcript.length });
  throw captureFault(FAULT.SCREEN_READER_MUTE,
    "NVDA is running but not speaking (afterStart.lastSpoken was empty and the read-through " +
    "produced " + transcript.length + " phrase(s)). Failing now so the worker cold-starts a fresh " +
    "screen reader for the next capture, rather than sweeping a silent one.");
}

/** The most recent diagnostic for an event, or undefined. */
/** @param {MarkLog} diag @param {string} event */
export function lastMark(diag, event) {
  return diag.entries.filter((entry) => entry.event === event).at(-1);
}

/**
 * Did NVDA say nothing at all when it started?
 *
 * On its own this is NOT proof of a mute screen reader -- see the warning at the top of this file --
 * which is why both callers pair it with "and the read-through heard nothing either".
 */
/** @param {MarkLog} diag */
export function screenReaderWasSilentAtStart(diag) {
  return lastMark(diag, "afterStart")?.lastSpoken === "";
}

// Walk one direction with a single quick-nav command until it runs out, the cap
// is hit, or the deadline passes, appending each new element to `out`.
// NVDA prefixes an announcement with the container it just entered, so the SAME element is
// announced two different ways depending on which direction you reach it from:
//
//   "heading, level 1, Market garden 044 guide"
//   "main landmark, heading, level 1, Market garden 044 guide"
//
// A raw prefix key treats those as two elements. It shows up as a phantom extra heading --
// harmless to the assertions, but it is noise in the evidence, and it got worse once the
// sweep stopped starting from a fixed position. Strip a leading container announcement before
// keying.
// The separator before the role may be a COMMA, not just a space. NVDA announces both shapes:
//
//   "main landmark, heading, level 1, Market garden 044 guide"           <- space
//   "Main support article, region, heading, level 2, Resetting a password"  <- comma
//
// Both are real announcements from `runs/`. They are quoted verbatim on purpose: the examples here were
// once written from memory, name-before-role, which is a shape NVDA has never produced in this corpus.
//
// Only the first was matched, so the second survived deduping and the same h2 was recorded twice --
// three headings on a page with two. Found by the CDP census (sweep 3, page 2), which is exactly the
// kind of miscount that is invisible without an independent count to compare against.
export const CONTAINER_PREFIX = /^(?:\w[\w\s'-]*[,\s]\s*)?(?:landmark|region|banner|navigation|main|complementary|content info|form|article),\s*/i;

/**
 * The key `collectPhrase` dedupes on — every container prefix removed, not just the first.
 *
 * STRIPPED REPEATEDLY since protocol 8 (known-gaps §18). `CONTAINER_PREFIX` removes ONE leading container
 * announcement, and NVDA announces EVERY container it entered, so a nested one survived and the same
 * element keyed two ways:
 *
 *   "main landmark, Home energy, region, Home energy"     reached from outside
 *   "Home energy, region, Home energy"                    reached from inside
 *
 * `structure.landmarks` then reported 3 landmarks on a page with 2. Measured across 5,304 captures: 146 of
 * 24,774 sweep announcements affected, in 34 captures, every one a `landmark-*` case. The transcript
 * channel was clean at 0 of 35,647, because `dedupeKey` is never applied to it.
 *
 * VERIFIED BEFORE APPLYING: over all 24,774 sweep announcements the repeated strip changes 146 keys and
 * reduces NONE to empty — the over-strip signature this would otherwise risk. `MAX_CONTAINER_DEPTH` bounds
 * it anyway, because a pathological announcement must not make this loop the slow part of a capture.
 */
export const dedupeKey = (/** @type {string} */ phrase) => {
  let key = String(phrase);
  for (let depth = 0; depth < MAX_CONTAINER_DEPTH; depth += 1) {
    const stripped = key.replace(CONTAINER_PREFIX, "");
    if (stripped === key) break;
    key = stripped;
  }
  return key.slice(0, DEDUPE_KEY_LEN);
};

/**
 * How many nested containers one announcement can carry.
 *
 * NVDA announces the containers it passed through on the way in, and real pages nest a handful at most —
 * the deepest observed in 24,774 corpus announcements is two. Bounded rather than looped to a fixed point
 * so a malformed announcement cannot spin here; four is well clear of anything measured.
 */
const MAX_CONTAINER_DEPTH = 4;

/**
 * Given the speech log and how much of it we had already read, did the last quick-nav jump MOVE, and
 * if so what was announced?
 *
 * Extracted so the rule can be tested without NVDA. The bug it replaces was a reasoning error rather
 * than a coding one -- "the spoken phrase changed" was treated as proof of movement -- and a reasoning
 * error is only pinned down by a test that states the intended rule. `sweep-step.test.ts` asserts the
 * case that used to produce a phantom: NVDA silent, `lastSpokenPhrase` still holding older text.
 *
 * @param {{log: string[], seen: number, prev: string}} state
 * @returns {{phrase?: string, stop?: string, seen: number}} `stop` names WHY, so a diagnostic can
 *   distinguish "ran out of elements" from "the channel was rebuilt" -- previously both were `break`.
 */
/**
 * An ANTI-SPIN BACKSTOP, not a movement detector — and the distinction is the whole lesson here.
 *
 * Identical announcement text cannot tell "the cursor did not move" from "the cursor moved to something
 * announced the same way", so no threshold makes it a sound movement test. Raising it from 1 to 3 took the
 * graphic sweep on a real page from 5 items to 59 of 66; the sweeps that still stopped early were the ones
 * whose page has FOUR consecutive images announced "Joe Kearns Avatar", which is simply what a testimonial
 * row looks like. Chasing the number is chasing the wrong signal.
 *
 * What actually terminates a sweep correctly is NVDA's own answer — "no next graphic" — which the `exhausted`
 * branch catches, and which four of six sweeps on that page reported. This constant exists only so a stuck or
 * wrapping cursor cannot burn the whole budget, and `MAX_SWEEP_STEPS` plus the deadline are the real bounds.
 * So it is set well above any plausible run of identical siblings: a table of twenty identical "Edit" links is
 * ordinary markup, and losing the rest of the page to it would be the original defect in a slower form.
 */
export const MAX_CONSECUTIVE_REPEATS = 25;

/**
 * @typedef {"cap"|"channelReset"|"deadline"|"error"|"exhausted"|"focusModeStuck"|"repeat"|"silent"} SweepStop
 *   Every reason a sweep can end, enumerated. Not decoration: as a bare `string` this does not narrow at
 *   all, because `""` is a valid string and falsy, so `if (step.stop)` cannot rule the stopped branch out
 *   of the `else`. Written down, the eight reasons are also the answer to "why did this sweep find
 *   nothing?", which is the question `stopPhrase` was added for.
 *
 * @typedef {{ seen: number, stop: SweepStop, phrase?: undefined, repeats?: number, silentRetries?: number }} SweepStopped
 * @typedef {{ seen: number, stop?: undefined, phrase: string, repeats?: number }} SweepAdvanced
 * @typedef {SweepStopped | SweepAdvanced} SweepStep
 *
 *   DISCRIMINATED, because the invariant is real and the caller depends on it: every return below carries
 *   EITHER a `stop` or a `phrase`, and the sweep does `if (step.stop) return ...` and then reads
 *   `phrase.length`. A flat optional-everything shape says that read might be undefined, which is both
 *   untrue and unfixable without a guard for a case that cannot arise.
 *
 *   NARROWING WAS ESTABLISHED BY COMPILING A THREE-LINE PROBE, twice, and the first answer was wrong.
 *   Splitting the union across two named halves changed nothing, because the discriminant was `string`
 *   and `""` is a falsy string -- so the `else` could still be the stopped branch. Only enumerating the
 *   stop reasons made it decide. Reading the type would never have told me either of those things; this
 *   repo's rule that escaping is settled by RUNNING it applies to type expressions exactly as it does to
 *   Jinja, and for the same reason: what fails is silent.
 *
 *   ONE shape for what a sweep step reports, because three places produce one and they were producing
 *   three different object literals. TypeScript unions them into something on which no field is safely
 *   readable -- and the caller reads `.phrase` and `.repeats` off whatever came back. `stopPhrase` exists
 *   because a sweep reporting `found=0 stop=repeat` says only "nothing" while `stopPhrase: "k"` says NVDA
 *   was in focus mode and this pipeline typed its own quick-nav key into the page, which went unnoticed
 *   for 2,122 captures. A shape that cannot carry the field is how that happens again.
 *
 * @param {{ log: string[], seen: number, prev?: string, repeats?: number }} state
 * @returns {SweepStep}
 */
export function sweepStepFromSpeech({ log, seen, prev, repeats = 0 }) {
  const entries = log ?? [];
  // Shorter than what we already consumed means the log was cleared under us: a speech-channel
  // rebuild. Slicing into it would silently invent a delta out of unrelated phrases.
  if (entries.length < seen) return { stop: "channelReset", seen: entries.length };
  const spoken = entries.slice(seen).map((phrase) => String(phrase).trim()).filter(Boolean);
  const advanced = entries.length;
  // The whole point: no new speech means no movement. This is the branch where the old test lied.
  if (!spoken.length) return { stop: "silent", seen: advanced };
  // The LAST entry, which is exactly what lastSpokenPhrase returned -- so a capture in which NVDA
  // speaks yields byte-identical evidence to before the fix, and 2,122 cached captures stay valid.
  const phrase = spoken[spoken.length - 1];
  if (/\bno (next|previous|more)\b/i.test(phrase)) return { stop: "exhausted", seen: advanced };
  // A repeated phrase needs CONSECUTIVE repeats, not one.
  //
  // The comment in `sweepInDirection` already named the flaw and then stopped on it anyway: silence is
  // unambiguous evidence of not moving, but an unchanged phrase is ambiguous between "did not move" and
  // "moved to something announced the same way". Stopping on the first one resolves that ambiguity the wrong
  // way, and real pages are full of the second case — a marketing page with 66 images and 47 distinct alt
  // values has four images all announced "Joe Kearns Avatar". Measured on one: the graphic sweep reported
  // `stop: repeat` after 5 items on a page whose accessibility tree contains 66 graphics, while the link
  // sweep, whose text is mostly distinct, reached 52 of 58. The sweep was not running out of page, it was
  // running into duplicate alt text.
  //
  // Note WHY this is safe: `spoken.length` was non-empty to reach this line, so NVDA said something new and
  // the cursor did move. The silent branch above already catches a cursor that did not, and `exhausted`
  // catches NVDA's own "no next graphic". This threshold is only for the remaining case — a genuine wrap or
  // a stuck position that keeps re-announcing — and `seenKeys` in the caller discards the duplicates either
  // way, so the cost of the extra steps is time, not wrong evidence.
  if (phrase === prev) {
    const consecutive = repeats + 1;
    return consecutive >= MAX_CONSECUTIVE_REPEATS
      ? { stop: "repeat", seen: advanced, repeats: consecutive }
      : { phrase, seen: advanced, repeats: consecutive };
  }
  return { phrase, seen: advanced, repeats: 0 };
}

// A tree ROW as NVDA announces it while focused:
//   "main, tree view item, focused, selected, expanded, 1 of 1, level 0"
// An EMPTY tree announces only the container -- "tree view, focused" -- with no item name, which is the
// signal that a type has no elements. Distinguishing those two is the whole reason this reads the
// focused item rather than counting: a silent read means "could not tell", not "none".
export const TREE_ROW_RE = /\btree view item\b/i;

/**
 * The item name, stripped of the tree-view chrome NVDA appends.
 *
 * Position and level are deliberately discarded. The obvious-looking shortcut is to parse the "1 of 1"
 * suffix as a total, and it is WRONG: the list is HIERARCHICAL (a `<main>` containing a `<form>` reads
 * "level 0 ... 1 of 1" with the form as a child), so that number counts siblings at one level, not
 * elements in the document. Reading it as a total silently undercounts every nested structure.
 */
/**
 * @param {string | undefined} phrase
 *   UNDEFINED IS A TESTED INPUT (`cross-check.test.ts`), and the body coerces before touching it. A
 *   stricter type would describe a function the callers do not have.
 */
export function elementsListRowName(phrase) {
  const text = String(phrase ?? "").trim();
  if (!TREE_ROW_RE.test(text)) return null;
  return text
    .replace(/,?\s*tree view item\b/i, "")
    .replace(/,?\s*\b(?:focused|selected|expanded|collapsed)\b/gi, "")
    .replace(/,?\s*\b\d+ of \d+\b/i, "")
    .replace(/,?\s*\blevel \d+\b/i, "")
    .replace(/[\s,]+/g, " ")
    .trim() || null;
}

/**
 * The oracle's count for one type, and WHICH of its two numbers it came from.
 *
 * `distinct` counts distinct NAMES; the bare entry counts elements. The sweep dedupes announcements, so
 * distinct names is the like-for-like comparison — but `distinct` may not cover every type the oracle
 * reported, and falling back silently would mix the two inside one verdict. Returning the provenance
 * beside the number is the same rule the rest of this file follows: a number carries what it came from.
 *
 * @param {Record<string, number | undefined> | undefined} elementsList
 * @param {string} type
 * @returns {{ value: number | undefined, fromDistinct: boolean }}
 */
function authoritativeCount(elementsList, type) {
  const distinct = /** @type {any} */ (elementsList)?.distinct?.[type];
  if (typeof distinct === "number") return { value: distinct, fromDistinct: true };
  return { value: elementsList?.[type], fromDistinct: false };
}

/**
 * Compare what the sweeps found against what NVDA's Elements List reports.
 *
 * Reports; decides nothing. A disagreement is evidence about the CAPTURE, not about the page, and the
 * layers that gate on evidence must be able to see the difference.
 *
 * A count may legitimately be absent on either side — a type the dialog could not be read for, or one
 * the sweep did not run — so the value type admits `undefined` deliberately. Declaring these as plain
 * numbers would be a lie about the one input the function exists to handle carefully.
 *
 * @param {{sweep: Record<string, number | undefined>, elementsList: Record<string, number | undefined>}} counts
 */
export function crossCheckStructure({ sweep, elementsList }) {
  const differences = [];
  let compared = 0;
  let usedFallback = false;
  // Whatever BOTH sides name. Previously this iterated NVDA's five Elements List types, which silently
  // ignored any type the oracle could speak about but that list cannot -- and the CDP census covers
  // graphics and links too. Comparing the intersection keeps it honest in both directions.
  for (const type of Object.keys(sweep ?? {})) {
    const found = sweep?.[type];
    // DISTINCT NAMES WHEN THE ORACLE HAS THEM, the raw element count only when it does not.
    //
    // The sweep DEDUPES — `collectPhrase` drops an announcement it has already seen — so it produces
    // distinct announcements, while the element count counts elements. Measured 2026-08-29 across 106 real
    // captures: 75% of named elements share a name with another, and every page has at least one
    // duplicate. Comparing those two numbers reported a disagreement on 97% of pages, roughly half of it
    // definitional. This compares like with like; an older capture without `distinct` falls back and is
    // marked as such by `basis`, so a stale comparison cannot pass for a current one.
    const { value: authoritative, fromDistinct } = authoritativeCount(elementsList, type);
    if (typeof authoritative === "number" && !fromDistinct) usedFallback = true;
    // Absent is not a disagreement: a type the dialog could not be read for must not be reported as
    // a mismatch against a sweep that did run. Only two KNOWN numbers that differ are evidence.
    if (typeof found !== "number" || typeof authoritative !== "number") continue;
    compared += 1;
    if (found !== authoritative) {
      differences.push({
        type,
        // NAMED FOR WHAT THEY ARE, and no `kind`. This used to render
        // `kind: found > authoritative ? "phantom" : "truncated"`, which is a VERDICT the worker cannot
        // justify: `sweep` is `structure.links.length`, an ENTRY COUNT, and `authoritative` is a count of
        // distinct NAMES. Those differ in both directions for reasons that are not defects — two links
        // sharing a name are two announcements and one name; one landmark entry can announce several
        // landmarks and some announce none.
        //
        // Measured on 675 fresh protocol-7 captures, worker-side against host-side on the same evidence:
        // the worker agreed 51% of the time and called `link` phantom 191 times, while the host's
        // `sweepCompleteness` — which parses the announcements — was exact on 60 of 60 links. Its 13
        // landmark truncations were REAL: the documented caret rule, where quick navigation cannot reach a
        // landmark containing the caret.
        //
        // The worker has no announcement grammar to do better with. `parseAnnouncement` is TypeScript and
        // this file is plain node on the guest, so the split C1 established is the answer: the WORKER
        // records what it measured, the HOST judges. Rendering a verdict it cannot compute is how a
        // diagnostic comes to be believed.
        sweepEntries: found,
        oracleDistinctNames: authoritative,
      });
    }
  }
  // `compared` is not bookkeeping, it is the difference between "checked and agreed" and "checked
  // nothing". The first version returned agrees:true when every count was unreadable, so a probe that
  // read the wrong control and parsed nothing reported AGREES -- a verification that cannot fail,
  // which is the exact defect this cross-check was built to catch elsewhere.
  // WHICH ORACLE THIS VERDICT RESTS ON. "Compared against distinct names" and "compared against raw
  // element counts" are different claims, and a reader who cannot tell them apart will read a stale
  // capture's disagreement as the same finding as a current one.
  // PER COMPARISON, not per capture. `distinct` being PRESENT does not mean it covered every type
  // compared: the lookup falls back to the raw element count type by type, so one absent entry silently
  // mixes distinct names and element counts inside a verdict labelled "distinct-names". Those two numbers
  // differ by 75% on real pages -- that measurement is the whole reason `distinct` exists -- so a reader
  // told the wrong basis is told the wrong thing about the disagreement in front of them.
  //
  // Not observed: no capture on disk carries `distinct` yet, because it lands with the recapture in
  // flight. Written this way because "the same census builds both, so they cover the same types" is an
  // assumption, and an unverifiable assumption reported as a fact is what `basis` exists to prevent.
  const basis = !elementsList?.distinct ? "element-counts"
    : usedFallback ? "mixed-distinct-names-and-element-counts"
      : "distinct-names";
  // `differsOn`, not `disagreements`, and `sameCounts`, not `agrees`. Both old names read as verdicts on
  // the PAGE; these two numbers differing is usually a fact about how they are counted. `sweepCompleteness`
  // on the host is the verdict, and `capture:explain` already reports that one and prints these as raw.
  return { sameCounts: compared > 0 && differences.length === 0, compared, differsOn: differences, basis };
}

/**
 * WHICH probe an announced control earns — the safety gate on what this tool presses.
 *
 * Here rather than in `capture-core` because this is the decision that has to be TESTABLE.
 * `probe-forms` defaults on in the GitHub Action, so "reviewing a page" now means operating controls on
 * it, and the question "could this press *Delete account*?" must have an answer that does not require a
 * Windows VM. `capture-core` imports guidepup, which throws at module load without a screen reader, so
 * nothing there can be unit-tested at all.
 *
 * The rules, in order, and each one is load-bearing:
 *
 * 1. A disclosure is activated UNCONDITIONALLY, with no `probeForms` gate, because expanding something
 *    is side-effect-free — and whether the expanded state is announced at all is 4.1.2.
 * 2. Everything else needs `probeForms`, and must be a button. Activating a link navigates away.
 * 3. A submit-like NAME is activated, because an error nobody hears (3.3.1) only exists after a submit.
 * 4. Any other button only if its name shares a meaningful word with the user's task — so "show only
 *    bags" presses *Bags* and never *Delete account*. Role and state words are excluded from that match,
 *    or every button would match a task containing the word "button".
 *
 * @param {string} phrase the control as the screen reader announced it
 * @param {{ probeForms?: boolean, task?: string }} options
 * @returns {"disclosure" | "submit" | "task" | null}
 */
export function probeKindFor(phrase, { probeForms, task }) {
  // Coerced ONCE. This runs per announced control on every capture, and `taskNamesControl` calls
  // `.toLowerCase()`, so a non-string reaching that far would throw inside a probe — which this pipeline
  // records as the page announcing nothing, and that is a real finding's signature.
  const announced = String(phrase ?? "");
  if (/\bcollapsed\b/i.test(announced)) return "disclosure";
  if (!probeForms || !/\bbutton\b/i.test(announced)) return null;
  if (SUBMIT_RE.test(announced)) return "submit";
  if (taskNamesControl(announced, task ?? "")) return "task";
  return null;
}


/**
 * The budget ladder, and why these four numbers have to live together.
 *
 * A capture nests inside three deadlines: this budget, the worker's hard timeout, and the host's
 * per-capture timeout. They were defined in three files and nobody checked they were ordered — the budget
 * was 120 s inside a 240 s hard timeout, so a capture was cut off less than half way to the limit its own
 * worker tolerated. `budgetLadderIsSound` asserts the ordering, because an inverted ladder does not fail
 * loudly: it silently truncates evidence and the capture still returns 200.
 *
 * MEASURED on the W3C survey page, which is what these values are set from. Startup is NOT charged to the
 * budget (the deadline is taken after NVDA is up), and the read-through completed naturally:
 *
 *   read-through   61 s   89 lines, stopReason `repeatBottom`
 *   heading+landmark 8 s
 *   formField      43 s   16 fields, activating controls
 *   link/list/postSubmit  starved -- all three returned `deadline` having examined nothing
 *
 * `postSubmit` is where 3.3.1 and 4.1.3 evidence lives, so the phases carrying the criteria this tool
 * uniquely covers were the ones that starved. That is an ORDERING accident, not a page problem: the
 * deadline is shared first-come-first-served and the interaction probes run last.
 *
 * Raising the budget is close to free, which is the part that was missed for a long time: a budget is a
 * CEILING, not a cost. A page that finishes in 12 s still takes 12 s. Only pages that need more are
 * affected, and those are exactly the pages currently losing evidence.
 */
export const DEFAULT_BUDGET_MS = 420_000;

/**
 * Time held back from the read-through for everything after it.
 *
 * The deliberate trade: a truncated read-through loses the TAIL of a linear read, which is the evidence
 * most likely to repeat what the head already said, and it reports its own `stopReason`. A starved probe
 * loses 3.3.1 and 4.1.3 entirely, and nothing else in the pipeline can reach them. So when the two compete,
 * the read-through yields.
 */
export const POST_READ_RESERVE_MS = 60_000;

/** What the worker abandons a capture at. The default only; `server.mjs` keeps its env override. */
export const CAPTURE_HARD_TIMEOUT_DEFAULT_MS = 520_000;

/**
 * Worst observed time from request to NVDA being ready, which the budget does NOT include but the hard
 * timeout DOES. Measured at 44 s on a cold start that also restarted NVDA once; 50 s is that plus margin.
 */
export const WORST_CASE_STARTUP_MS = 50_000;

/**
 * When the read-through must stop, leaving the reserve for the phases after it.
 *
 * Scales down rather than going negative: a caller passing a small `maxMs` (the tests do) would otherwise
 * get a deadline in the past and read nothing at all. With little left, the read-through still gets half.
 */
/** @param {number} captureDeadline @param {number} [now] */
export function readThroughDeadline(captureDeadline, now = Date.now()) {
  const remaining = captureDeadline - now;
  if (remaining <= 0) return captureDeadline;
  const reserve = Math.min(POST_READ_RESERVE_MS, Math.floor(remaining / 2));
  return captureDeadline - reserve;
}

/** Is the ladder ordered? Exported so a test can assert it rather than a comment claiming it. */
/**
 * @param {{ budgetMs: number, hardTimeoutMs: number, hostTimeoutMs: number, startupMs: number }} ladder
 */
export function budgetLadderIsSound({ budgetMs, hardTimeoutMs, hostTimeoutMs, startupMs }) {
  return POST_READ_RESERVE_MS < budgetMs
    && budgetMs + startupMs < hardTimeoutMs
    && hardTimeoutMs < hostTimeoutMs;
}

/**
 * The comparable SHAPE of a structural census, or null when there is nothing to compare.
 *
 * Pulled out of `waitForPageToSettle` because it was wrong there and the wrongness was invisible.
 * `structuralCensus()` answers `{ error }` when CDP does not reply -- truthy, so a guard testing only for
 * a missing value let it through, and reading four absent counts off it produced the literal string
 * `"undefined/undefined/undefined/undefined"`. Two failures in a row therefore compared EQUAL, and the
 * settle wait returned "settled" having learnt nothing about the page.
 *
 * That matters more than it looks. This is the only non-speech wait in the capture path, and it exists
 * because speech settles just as happily on a shell as on a rendered page: the Met Office warnings page
 * captured as `"blank"` with a census of heading=0 against forty headings in its published HTML, and
 * produced two WCAG findings against a page that has neither fault. A census that cannot answer skipping
 * the wait puts that back.
 *
 * Null for "no reading", never a string, so a caller comparing consecutive shapes cannot accidentally
 * match two non-answers -- the distinction this repo keeps having to make between an empty result and an
 * absent one.
 *
 * @param {{ heading?: number, link?: number, graphic?: number, landmark?: number, error?: string }
 *         | null | undefined} census
 * @returns {string | null}
 */
export function censusShape(census) {
  if (!census || "error" in census) return null;
  return `${census.heading}/${census.link}/${census.graphic}/${census.landmark}`;
}


// --- Page identity, browser error pages, and the focus cycle -------------------------------------
//
// MOVED HERE FROM `capture-core.mjs` on 2026-08-30, verbatim including their comments, for the reason
// this file exists: guidepup constructs a ScreenReader at MODULE SCOPE and throws `No available
// supported screen readers` where there is none, so importing `capture-core.mjs` AT ALL fails on Linux.
//
// Four test files reached these helpers through it and died with it the moment `main` went green enough
// to run: `browser-error-page`, `focus-order-cycle`, `landed-on-page`, and `file-version-memo` via
// `server.mjs`, which imports capture-core too.
//
// THAT IS known-gaps §12 A SECOND TIME. Its fix switched two files from package-name imports to relative
// ones and added `no-win32-imports.test.ts` to keep them that way — but a relative import of
// capture-core is poisoned just the same, and that guard's `isSource` EXCLUDES `.test.ts`, so it could
// never look at the four files that were failing. The remedy reached two of six, and its guard was blind
// to the rest.
//
// `capture-core.mjs` imports and re-exports every one of these, so its callers are unchanged.

/** Between reads of the browser's current URL. A poll INTERVAL, not a guess at how long a load takes. */
const LANDED_POLL_MS = 100;
export const LANDED_BUDGET_MS = 30_000;
const FOCUS_CYCLE_CONFIRM = 3;

const BROWSER_ERROR_TITLE_RE =
  /can.t reach this page|no internet|site can.t be reached|refused to connect|ERR_[A-Z_]+/i;

/**
 * Titles Edge gives its own error pages, which are not the page under test.
 *
 * Deliberately matched on the TITLE rather than on transcript content: the title is one string NVDA
 * reports before anything else, so this fails fast and cannot be confused with a site whose prose
 * happens to mention connectivity. Chromium's error titles are stable and short.
 */
/** Exported so the guard can be shown to FAIL — a check never seen to reject anything is untested. */
export const isBrowserErrorTitle = (/** @type {unknown} */ title) => BROWSER_ERROR_TITLE_RE.test(String(title ?? ""));

/**
 * Did the browser open the page we asked for?
 *
 * The one fact that settles it, and `currentPageUrl` has been imported into this file all along to
 * answer a different question. Measured 2026-08-25: a fixture capture came back with 173 transcript
 * lines containing `"Back to Bing search"` and the title `"localhost - Search - Profile 1 - Microsoft
 * Edge"`. Edge had treated the address as a SEARCH QUERY and gone to Bing — which is a real page with a
 * real title, so every readiness check passed and it was recorded as evidence about the fixture.
 *
 * That is the THIRD distinct way one afternoon produced a capture of the wrong page, after a dead port
 * and a host the worker could not reach. The first two are caught by the error-page title guard; this
 * one cannot be, because Bing is not an error. Comparing the URL catches all three and anything else of
 * the same shape, which is why it belongs here rather than beside either specific fix.
 *
 * Compared on ORIGIN AND PATH only. A site may legitimately add a query string, a fragment or a
 * trailing slash, and failing a capture for that would be a guard that cries wolf — while a redirect to
 * a different host or path is exactly what this must catch. A capture whose URL cannot be read at all
 * makes no claim: `currentPageUrl` returns null when CDP is unreachable, which is a separate fault
 * already reported elsewhere.
 */
/**
 * Two paths that address the same document.
 *
 * A trailing slash and a `.html` extension are both things a SERVER may add or drop while serving
 * exactly what was asked for. Measured 2026-08-25, and it cost a run: `serve` logs
 * `GET /route-title-stale/bad` for a request to `/bad.html` — it resolves the extension and the browser's
 * URL then ends `/bad`, so a strict comparison rejected two captures that were completely correct. The
 * whole run reported 0/3.
 *
 * That is the guard crying wolf, which is worse than useless: a check that fails on correct input gets
 * switched off, and this one exists to catch three real ways of capturing the wrong page. Normalising
 * here keeps it able to see a redirect to a different host or a different document, which is what it is
 * for, and blind to a rewrite that changes neither.
 */
/** @param {string} a @param {string} b */
export function samePath(a, b) {
  const normalise = (/** @type {string} */ path) => path.replace(/\/$/, "").replace(/\.html?$/i, "").replace(/\/index$/i, "");
  return normalise(a) === normalise(b);
}

/** Does what the browser is showing address the same document we asked for? PURE. */
/** @param {string} actual @param {string} url */
export function addressesSamePage(actual, url) {
  let got;
  try {
    got = new URL(actual);
  } catch {
    return null; // not a URL at all: this guard makes no claim
  }
  const want = new URL(url);
  return got.origin === want.origin && samePath(got.pathname, want.pathname);
}

/**
 * Poll until the browser is showing the requested page, or the budget runs out.
 *
 * POLLED, never read once — and the one-shot version cost five captures the day it shipped.
 *
 * `browserReady` means `browserAlive()` returned true, and that only proves **the DevTools port
 * answers**. It is not a claim that the requested URL has loaded. So reading the URL immediately after
 * `openPage` reads whatever document the browser happens to be showing, which after a recycle is the
 * previous one while the new navigation is still in flight.
 *
 * Measured 2026-08-25, from the diagnostics of five failed captures on one worker:
 *
 *     browserClosed  atMs 8153  forced: true
 *     browserReady   atMs 8163
 *     landedOnRequested atMs 8164  ok: false   <- ONE MILLISECOND later
 *
 * Every one followed `browserRecycle after: 25`, and the `actual` URL was a real page the server was
 * serving. Nothing was unreachable; the check simply looked before the navigation landed.
 *
 * This is the defect CLAUDE.md's longest section is about, committed in a new place: *"a condition must
 * be sufficient — `screenReaderResponds()` only proves the Remote port accepts a TCP connection, not
 * that NVDA's virtual buffer is navigable."* `browserAlive()` is that same insufficient condition one
 * subsystem over, and this guard was built on top of it with no poll at all.
 *
 * The budget must exceed the slowest HONEST navigation, because a wrong page is a legitimate finding and
 * a guard that gives up early turns "still loading" into "wrong page" — the same inversion a short sleep
 * once turned into "the page announced nothing". It costs nothing when the page is already right: the
 * first read matches and the loop exits.
 *
 * INJECTABLE, because the entire defect is about WHEN the URL is read and a test that cannot control
 * time cannot see it — the same reasoning as `file-version-memo.test.ts`.
 *
 * @returns {Promise<{ok: boolean, actual: string|null, attempts: number, waitedMs: number}>}
 */
/**
 * @param {string} url
 * @param {{ read: () => Promise<string|null>, budgetMs?: number, pollMs?: number,
 *           now?: () => number, wait?: (ms: number) => Promise<void> }} options
 */
// NO `= {}` DEFAULT: `read` has none either, so an omitted options object gives `read === undefined` and
// the loop below calls it. Every one of the four call sites passes `{ read: ... }`. Same contradiction as
// `refuseUnknownFlags` had -- a default that makes a required argument optional.
export async function landedVerdict(url, options) {
  const {
    read, budgetMs = LANDED_BUDGET_MS, pollMs = LANDED_POLL_MS,
    now = () => Date.now(), wait = sleep,
  } = options;
  const startedAt = now();
  let actual = null;
  let attempts = 0;

  while (now() - startedAt < budgetMs) {
    attempts += 1;
    actual = await read();
    // A null URL is CDP being unreachable, which is a DIFFERENT fault reported elsewhere — but it is also
    // transient right after a launch, so it is retried rather than taken as a verdict.
    if (actual && addressesSamePage(actual, url) === true) {
      return { ok: true, actual, attempts, waitedMs: now() - startedAt };
    }
    await wait(pollMs);
  }
  return { ok: false, actual, attempts, waitedMs: now() - startedAt };
}

/**
 * The decision alone, EXPORTED so it can be shown to refuse.
 *
 * Separated from the CDP call for the reason `failIfScreenReaderIsMute` is: a guard that has never been
 * seen to reject anything is untested, and the integration path needs a Windows guest and a dead port to
 * exercise. This is a pure function of the status, so the three outcomes are provable in milliseconds and
 * the remaining risk is confined to whether `navigationOutcome` reads the right number.
 *
 * @param {string} url
 * @param {{status?: number|null} | null} outcome
 * @returns {string|null} the refusal message, or null to proceed
 */
export function pageServedRefusal(url, outcome) {
  // "We could not ask" is not a refusal, and it is not a pass either -- the caller MARKS it. Conflating
  // absence with zero would turn a browser too old to report the status into a permanently broken worker.
  if (!outcome || outcome.status === null || outcome.status === undefined) return null;
  if (outcome.status >= 200 && outcome.status < 300) return null;
  if (outcome.status === 0) {
    return `nothing is serving ${JSON.stringify(url)} — the browser got no HTTP response at all, so what `
      + "it displayed is its own error page, not the site";
  }
  return `the server answered HTTP ${outcome.status} for ${JSON.stringify(url)}, so the document captured `
    + "is an error page rather than the page requested";
}

/** Have we returned to where we started? See `FOCUS_CYCLE_CONFIRM` for why this is not one comparison. */
/** @param {string[]} stops */
export function focusOrderCycled(stops) {
  if (stops.length < FOCUS_CYCLE_CONFIRM * 2) return false;
  return stops.slice(-FOCUS_CYCLE_CONFIRM)
    .every((phrase, i) => phrase === stops[i]);
}
