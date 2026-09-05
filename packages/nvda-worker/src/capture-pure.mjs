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
// `section` joined this list on 2026-09-05, and it is the SAME FACT that lives in three other places:
// `CONTAINER_ROLES` in announcement.ts, `CONTAINER_PREFIX` in screenreader_features.py, and the counter in
// rules.ts. `w3c/html-aria#423` made the `form` role conditional on an accessible name, so Edge 152
// announces an unnamed <form> as "section" -- measured on one unchanged page, 151 said "form, name at
// example dot com, edit" and 152 says "section, ...". Every corpus form is unnamed.
//
// The comment on the Python copy already records these drifting apart once: "one fact in two languages,
// and the copies drifted -- the shape this repo has paid for five times in a day". It was four copies,
// not two, and this browser change moved all four at once.
export const CONTAINER_PREFIX = /^(?:\w[\w\s'-]*[,\s]\s*)?(?:landmark|region|banner|navigation|main|complementary|content info|form|section|article),\s*/i;

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
 * WHAT THIS CAPTURE ASKED, recorded beside what it heard — capture-protocol 9.
 *
 * A channel is a bare array, and a bare array cannot say why it is empty. `media` is the only field in the
 * whole capture that gets this right, and it carries a comment saying so: *"`null` means the probe did not
 * run and is NOT the same as an empty array, which means the page declares no media."* Every other channel
 * conflates the two, and the cost is measured — of 6,467 corpus captures, `formChanges` is empty on 4,830
 * and **3,006 of those were never asked**; ten of the 28 model features read only such channels.
 *
 * The capture already KNOWS. `probeForms`/`probeTables`/`probeFocus` decide what runs, and `collectByType`
 * records why every sweep stopped. Both go into `diagnostics`, which is a `FORBIDDEN_INPUT_KEY` — so the
 * capture's own record of its method is classified as debugging output. This lifts it to a first-class
 * sibling, which is a RELOCATION rather than new instrumentation.
 *
 * `exhausted` is the only sound terminus, because it is NVDA's own answer: it says "no next heading" when
 * there are none left. Every other stop — a deadline, a repeated phrase, silence, a stuck focus mode — is
 * the sweep giving up, and a sweep that gave up cannot support "the page has none of these".
 *
 * @param {{stop?: string}|undefined|null} prev  how the backward walk ended
 * @param {{stop?: string}|undefined|null} next  how the forward walk ended
 * @returns {{asked: true, complete: boolean, stop: {prev: string, next: string}}}
 */
export function sweepObservation(prev, next) {
  const prevStop = prev?.stop ?? "unknown";
  const nextStop = next?.stop ?? "unknown";
  return {
    asked: true,
    // BOTH directions, because `collectByType` walks backwards then forwards and merges them. One
    // exhausted direction and one that hit a deadline is a HALF-swept page, and reading it as complete is
    // the truncation-as-absence defect this whole field exists to remove.
    complete: prevStop === "exhausted" && nextStop === "exhausted",
    stop: { prev: prevStop, next: nextStop },
  };
}

/**
 * A channel nobody asked about. Distinct from `{asked: true}` with nothing found, and that is the point.
 *
 * `why` is required rather than defaulted: "the probe is opt-in and this case did not request it" and "the
 * page had no control to activate" are different facts, and a reader who cannot tell them apart is back
 * where they started.
 *
 * @param {string} why
 */
export function notObserved(why) {
  return { asked: false, why };
}

/**
 * WHICH probes needing DOM FOCUS were asked for — stated once, as data.
 *
 * Three channels share one precondition and it was written three times: Escape, an arrow and a typed
 * character all measure the DOCUMENT rather than a control unless `probeFocusOrder` has put real focus
 * somewhere first, because a sweep is browse mode and never moves DOM focus. That fact cost the dialog
 * probe three captures to discover, and repeating it per channel is three chances for the fourth one to
 * be added without it.
 *
 * `why` names WHICH precondition was missing, because "nobody asked" and "asked without the probe that
 * makes it meaningful" need opposite fixes and a bare `false` sends you to the wrong one.
 */
const FOCUS_DEPENDENT_PROBES = Object.freeze({
  dialogEscape: {
    flag: "probeDialog",
    ownReason: "probeDialog is opt-in: it presses Escape, which changes state on a page we do not own",
    withoutFocus: "probeDialog was asked WITHOUT probeFocus, and Escape from the browse caret measures the document",
  },
  arrowNavigation: {
    flag: "probeArrows",
    ownReason: "probeArrows is opt-in: it presses keys inside whatever widget focus last landed on",
    withoutFocus: "probeArrows was asked WITHOUT probeFocus, and an arrow in browse mode navigates the DOCUMENT",
  },
  typedFeedback: {
    flag: "probeTyping",
    ownReason: "probeTyping is opt-in: it enters characters into a field, changing the page under measurement",
    withoutFocus: "probeTyping was asked WITHOUT probeFocus, and typing in browse mode sends quick-nav COMMANDS",
  },
  focusContext: {
    flag: "probeFocusContext",
    ownReason: "probeFocusContext is opt-in: it moves focus, and a page that navigates on focus is changed by "
      + "the asking",
    withoutFocus: "probeFocusContext was asked WITHOUT probeFocus, and Tab in browse mode moves the BROWSE "
      + "cursor rather than DOM focus, so nothing would be focused to change context",
  },
});

/**
 * What this capture ASKED about the OPT-IN channels — the half `collectByType` cannot record for itself.
 *
 * The sweeps record their own observation as they run, because only they know how they ended. These are
 * decided by a FLAG rather than by a walk, so they are recorded in one place at the end: a chain of `if`s
 * scattered through the caller is a chance for the next probe to be added without one.
 *
 * `activated` separates the two states the boolean cannot — asked and something happened, asked and the
 * page had nothing to activate. That is what `formProbe: {activated: 0}` on the focus cases turned out to
 * mean: not a failure, but a page with no submit control, which is a fact about the page.
 *
 * **THERE WAS NO GUARD ON THIS, AND A COMMENT SAID THERE WAS.** The call site in `capture-core` named
 * `observation-parity.test.ts`, which tests the corpus-side and rules-side predicates for arrows and
 * Escape and nothing about these flags. A comment naming a guard that guards something else is worse than
 * no comment: it stops the next reader looking, and `formState` was omitted for as long as configured
 * forms have existed. This function lives HERE rather than in `capture-core` so a test can reach it at
 * all — that file imports guidepup, which throws at module load where no screen reader exists.
 *
 * `formState` is NOT a probe flag, and its presence is what tells this function a control was activated
 * while `probeForms` stayed false. Typed as the shape's presence rather than its contents: nothing here
 * reads a field or a value, only whether the caller declared one.
 *
 * @param {{ observed: Record<string, {asked: boolean, why?: string, activated?: number,
 *                                     configured?: boolean}>,
 *           probeForms?: boolean, probeFocus?: boolean,
 *           probeNavigation?: boolean, probeDialog?: boolean, probeArrows?: boolean,
 *           probeTyping?: boolean, probeFocusContext?: boolean, probeFocusReveal?: boolean,
 *           formState?: {state: string, submit: string, fields: unknown[]} | null,
 *           interaction: { formChanges: {control: string, after: string}[] } }} ctx
 */
export function recordWhatWasAsked({ observed, probeForms, probeFocus, formState, interaction, ...flags }) {
  // A CONFIGURED FORM IS AN ACTIVATION, and this function did not know it.
  //
  // `capture-real-pages` sends `probeForms: false` with a `formState` -- deliberately, and that posture is
  // right: the opportunistic probe presses whatever submit-like control the sweep walks past, on a page we
  // do not own, while a `formState` is the page owner's own example recorded in the corpus (ADR 0024). But
  // `probeForms` was the only thing consulted here, so every configured capture recorded *"probeForms is
  // off for this capture, so no control was activated"* about a control it HAD activated, and
  // *"probeForms is off"* about a form it HAD submitted and re-read.
  //
  // That is not a cosmetic wrong `why`. `observed` is what the featurizer crosses `formChanges` and
  // `postSubmitFields` against, and absent or `asked: false` is the "never asked" row -- so the real-page
  // captures carrying the ONLY 3.3.1 and 4.1.3 evidence this corpus has would have been marked as never
  // having looked for it. The field that exists to separate "the page has none" from "we could not ask"
  // said the second about the one capture that did ask.
  //
  // So the question is "was a control activated", not "was the opportunistic probe on". `configured` is
  // reported so a reader can tell WHICH probe did the asking without inferring it from the flags.
  const activated = probeForms || Boolean(formState);
  observed.formChanges = activated
    ? { asked: true, activated: interaction.formChanges.length, configured: Boolean(formState) }
    : notObserved("probeForms is off and no formState was configured, so no control was activated");
  observed.postSubmitFields = activated && interaction.formChanges.length > 0
    ? { asked: true, configured: Boolean(formState) }
    : notObserved(activated
      ? (formState
        ? "a formState was configured but activated nothing -- no field matched, or the submit was not "
          + "found -- so there was no submit to re-read after"
        : "probeForms ran and activated nothing, so there was no submit to re-read after")
      : "probeForms is off and no formState was configured");
  observed.focusOrder = probeFocus
    ? { asked: true }
    : notObserved("probeFocus is opt-in -- ~8s on a ~12s capture -- and this case did not ask");
  for (const [channel, { flag, ownReason, withoutFocus }] of Object.entries(FOCUS_DEPENDENT_PROBES)) {
    const asked = /** @type {Record<string, boolean|undefined>} */ (flags)[flag];
    observed[channel] = asked && probeFocus
      ? { asked: true }
      : notObserved(asked ? withoutFocus : ownReason);
  }
  observed.routeChange = flags.probeNavigation
    ? { asked: true }
    : notObserved("probeNavigation is opt-in: it ACTIVATES A LINK and can leave the page under measurement");
}

/**
 * Controls whose activation TOGGLES STATE and cannot navigate — see rule 5 and `SECURITY.md`.
 *
 * `radio button` is matched before the plain-button test on purpose: NVDA announces a radio as
 * "radio button", so whichever pattern reads it first decides what it is.
 *
 * `check box` is NVDA's spelling, two words. Written from real announcements rather than from the HTML
 * element name -- `announcement.ts` exists because seven partial regexes each guessed at NVDA's grammar,
 * and `checkbox` matches nothing it says.
 */
const TOGGLE_RE = /\b(check box|radio button)\b/i;

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
 * 5. A CHECKBOX or RADIO BUTTON under `probeForms`, with no name test — added 2026-09-01, decided in
 *    `SECURITY.md`. 4.1.3 asks whether a status message is announced, and a live region updated by a
 *    checkbox was structurally unreachable: real filters and consent toggles are checkboxes far more
 *    often than buttons.
 *
 * NO NAME TEST ON RULE 5, AND THAT IS THE DECISION RATHER THAN AN OVERSIGHT. Requiring a task word would
 * reproduce the gap it closes — a filter checkbox is named for the thing it filters, not for the task —
 * and the consent a button's name carries is doing different work there: activating a button IS its
 * purpose, so the name is the only thing standing between a probe and *Delete account*. A checkbox has no
 * such semantics to consent to; toggling it is the archetypal act of using a page.
 *
 * A `<select>`/combo box is DELIBERATELY NOT HERE. The jump-menu idiom sets `location.href` from an
 * `onchange`, so changing a select can navigate — the same reason rule 2 excludes links, and navigation is
 * what separates "we observed the page" from "we left it". `probeNavigation` is separately opt-in for that.
 *
 * @param {string} phrase the control as the screen reader announced it
 * @param {{ probeForms?: boolean, task?: string }} options
 * @returns {"disclosure" | "submit" | "task" | "toggle" | null}
 */
export function probeKindFor(phrase, { probeForms, task }) {
  // Coerced ONCE. This runs per announced control on every capture, and `taskNamesControl` calls
  // `.toLowerCase()`, so a non-string reaching that far would throw inside a probe — which this pipeline
  // records as the page announcing nothing, and that is a real finding's signature.
  const announced = String(phrase ?? "");
  if (/\bcollapsed\b/i.test(announced)) return "disclosure";
  if (!probeForms) return null;
  // BEFORE the button test, because NVDA announces a radio as "radio button" -- so `\bbutton\b` matches it
  // and it would otherwise fall through to the submit/task rules and be silently rejected for having no
  // task word. Order is the whole of it: the same string is two roles depending on which pattern reads it
  // first, which is this repo's "one element announced with TWO roles" defect from 2026-08-25.
  if (TOGGLE_RE.test(announced)) return "toggle";
  if (!/\bbutton\b/i.test(announced)) return null;
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

/**
 * The census roles a reveal can show up in, and the growth between two reads.
 *
 * NAMED ONCE. `focusRevealVerdict` had this list twice in its own body -- once for "did anything appear"
 * and once for "is it still there" -- and `probeFocusReveal` now needs the same question a third time,
 * once per tab stop, to decide whether to keep walking. Three copies of "what counts as revealed" is this
 * repo's most expensive shape, so the fact is stated here and the verdict reads it.
 */
export const REVEALABLE_ROLES = Object.freeze(["formControl", "link", "graphic", "heading", "landmark"]);

/**
 * Which of `REVEALABLE_ROLES` GREW between two censuses, as `[role, delta]` pairs — or `null` when either
 * read is unusable.
 *
 * A FAILED CENSUS IS NOT A READING OF ZERO, AND IT DOES NOT ARRIVE AS `null`. `structuralCensus` returns
 * `{ error }` when the CDP socket did not answer, so the obvious `if (!before)` guard passes the failure
 * straight through, every count reads 0, and a dropped connection becomes "nothing appeared on focus" --
 * which is a conformant page. That is absence read as a value, in the one place where absence IS the
 * question. `null` here is what keeps "we could not look" and "there was nothing" apart.
 *
 * @param {unknown} before
 * @param {unknown} after
 * @returns {Array<[string, number]> | null}
 */
export function censusGrowth(before, after) {
  const usable = (/** @type {unknown} */ read) =>
    (read && typeof read === "object" && !("error" in read))
      ? /** @type {Record<string, number>} */ (read)
      : null;
  const [b, a] = [usable(before), usable(after)];
  if (!b || !a) return null;
  return /** @type {Array<[string, number]>} */ (REVEALABLE_ROLES
    .map((key) => [key, Number(a[key] ?? 0) - Number(b[key] ?? 0)])
    .filter(([, delta]) => Number(delta) > 0));
}

/**
 * 1.4.13 Content on Hover or Focus — what three censuses and two focus reads MEAN, decided here so the
 * decision is testable without NVDA.
 *
 * THE CRITERION COVERS KEYBOARD FOCUS, WHICH IS WHY THIS EXISTS. It was recorded `out-of-scope` on the
 * reasoning "the screen-reader path never hovers" — true of the HOVER trigger and of the Hoverable bullet,
 * and it settles neither of the other two. Verbatim: *"Where receiving and then removing pointer hover OR
 * KEYBOARD FOCUS triggers additional content to become visible and then hidden"*. We drive keyboard focus.
 *
 * DISMISSABLE is the bullet this decides: *"a mechanism is available to dismiss the additional content
 * WITHOUT MOVING pointer hover or keyboard focus"*. So the observation is three counts and two focus
 * reads — focus a control, see whether content appeared, press Escape, see whether it went, and confirm
 * focus did not move in the process. If focus moved, the dismissal is not the mechanism the criterion asks
 * for and nothing here can claim anything.
 *
 * PERSISTENT is asymmetric and is deliberately NOT decided here. *"Remains visible"* is pixels, so it can
 * never be CONFIRMED from this evidence; content vanishing while the trigger still holds focus is
 * sufficient evidence of FAILURE without being necessary. That asymmetry is reported (`vanished`) and left
 * to the rule layer to weigh, because a probe that silently folds two bullets into one verdict is how a
 * criterion comes to be reported more confidently than its evidence allows.
 *
 * WHY A COUNT AND NOT A DIFF OF NAMES. The census is an AX-tree count, and the thing that appears on focus
 * is usually a tooltip or a disclosure — new nodes, not renamed ones. Comparing counts is what the census
 * can answer honestly; comparing names would need a stable identity the tree does not give us. An
 * unchanged count with changed content reads as `revealed: false`, which is a MISS rather than an
 * invention, and that is the direction this file fails in deliberately.
 *
 * @param {{ before: unknown, onFocus: unknown, afterEscape: unknown,
 *           focusBefore: string | null, focusAfter: string | null }} reads
 */
export function focusRevealVerdict({ before, onFocus, afterEscape, focusBefore, focusAfter }) {
  // A FAILED CENSUS IS NOT A READING OF ZERO, AND IT DOES NOT ARRIVE AS `null`. `structuralCensus` returns
  // `{ error }` when the CDP socket did not answer — so the obvious `if (!before)` guard passes the failure
  // straight through, every count reads 0, and a dropped connection becomes "nothing appeared on focus",
  // which is a conformant page. That is absence read as a value, in the one place where absence IS the
  // question, and `tsc` caught it in the first version of this function rather than a capture run.
  const revealedBy = censusGrowth(before, onFocus);
  if (revealedBy === null) return { asked: true, why: "census unavailable", revealed: null };
  if (revealedBy.length === 0) return { asked: true, revealed: false, why: "nothing appeared on focus" };

  // FOCUS MUST NOT HAVE MOVED, or Escape dismissed nothing — it navigated. The criterion's wording is the
  // whole reason this is checked rather than assumed: a mechanism that moves focus is not a mechanism to
  // dismiss "without moving focus".
  const focusHeld = Boolean(focusBefore) && focusBefore === focusAfter;
  const afterGrowth = censusGrowth(before, afterEscape);
  if (afterGrowth === null) {
    return { asked: true, revealed: true, revealedBy, focusHeld, dismissed: null,
      why: "census unavailable after Escape" };
  }
  const stillThere = afterGrowth.length > 0;
  return {
    asked: true,
    revealed: true,
    revealedBy,
    focusHeld,
    // `dismissed` answers Dismissable ONLY when focus held. Reported separately from `focusHeld` so a rule
    // can tell "Escape did nothing" from "Escape worked by navigating away", which are different pages.
    dismissed: !stillThere,
    // PERSISTENT's sufficient-failure half, reported and not judged: the content went while the trigger
    // still holds focus and nobody dismissed it.
    vanished: !stillThere && !focusHeld,
  };
}

const FOCUS_SCRIPT_BLUR_WINDOW_MS = 50;

/**
 * Is the CDP target a focus-event log was read from one this pipeline actually confirmed?
 *
 * The worker-side twin of `censusTargetIsSuspect` (`packages/evidence/src/verify.ts`) — same three lines,
 * same reasoning, kept as TWO copies rather than one shared function because this file runs as plain `.mjs`
 * on the Windows guest and that one is TypeScript compiled to `dist`; `focus-target-suspect-parity.test.ts`
 * is what keeps them from drifting apart instead.
 *
 * `targetMatch === undefined` is a capture from before this field existed at all: it cannot retroactively
 * accuse evidence nobody computed this for, so it reads as NOT suspect — never as "we don't know, so
 * assume the worst", which would silently blind every capture on disk today. `"matched"` is the CDP target
 * whose URL was confirmed against the one this capture asked for, so it is never suspect regardless of how
 * many pages were open. Anything else — `"fallback"`, `"no-expected-url"` — is unconfirmed, and whether it
 * is WORTH doubting turns on `candidates`: exactly one page open makes "fallback" the only page there ever
 * was, so `candidates <= 1` is safe and `> 1` (or the count itself missing) is not.
 *
 * @param {{ targetMatch?: string | null | undefined, candidates?: number | undefined }} target
 */
export function focusTargetIsSuspect({ targetMatch, candidates }) {
  if (targetMatch === undefined) return false;
  if (targetMatch === "matched") return false;
  return typeof candidates !== "number" || candidates > 1;
}

/**
 * ADJACENCY ALONE DOES NOT DISCRIMINATE, AND THE FIRST VERSION OF THIS FUNCTION GOT THAT WRONG — caught by
 * its own unit test, not by a capture. Per the UI Events spec, an ORDINARY Tab transition from A to B fires
 * `focusout(A)` and THEN `focusin(B)`, both as one browser-level change: focusout comes first, not second.
 * So across a whole walk the log reads `focusout(P), focusin(A), focusout(A), focusin(B), focusout(B), …` —
 * and `focusin(A)` is followed, a few events later, by `focusout(A)`, EXACTLY LIKE F55 would be. A pair
 * test with no timing component fires on every conformant control but the first, which the first version's
 * own test caught immediately once the fixture matched what a real page actually does rather than what the
 * comment above it assumed.
 *
 * THE REAL DISCRIMINATOR IS THE GAP. A script's `blur()` on `focus` runs synchronously (or on the next
 * microtask at the latest) — no human input and no round trip to NVDA happens in between, so the gap
 * between `focusin(X)` and its `focusout(X)` is on the order of a millisecond. An ORDINARY transition's
 * `focusout(A)` is caused by the NEXT Tab press, which cannot happen until `probeFocusOrder`'s loop has
 * sent the keystroke and read NVDA's announcement back — a round trip this codebase's own history puts at
 * a minimum of tens of milliseconds and typically far more (guidepup's speech-settle timers alone are
 * measured in the hundreds, per CLAUDE.md). So the two cases are separated by roughly two orders of
 * magnitude, and the comparison is between two ALREADY-RECORDED timestamps, not a guessed wait — this is
 * not the sleep-a-duration anti-pattern the rest of this codebase avoids, because nothing here is deciding
 * how long to wait; it is reading how long something that already happened actually took.
 *
 * `FOCUS_SCRIPT_BLUR_WINDOW_MS` — THE MARGIN IS NOW MEASURED, THE THRESHOLD ITSELF STILL IS NOT.
 *
 * It was written as a placeholder justified only by an assumed two-orders-of-magnitude gap. Measured
 * 2026-09-05 against a real capture of `focus-panel-undismissable-fee+with-component-index.bad`:
 * `probeFocusOrder` ran from atMs 23953 to 58952 over 18 stops, so **1,944 ms per Tab stop — a 38.9x
 * margin** over this 50 ms window. That is a mean across the whole probe and therefore an UPPER bound
 * on the gap, since each stop also pays for `reportFocusedControlWithRetry`; the true focusout→focusin
 * gap is smaller. It is still bounded below by a real NVDA keystroke round trip, which this repo
 * measures in hundreds of milliseconds, never in tens.
 *
 * A SECOND, MORE DIRECT MEASUREMENT, from a real page rather than a probe-wide average: a real capture
 * carrying `interaction.focusEvents` (116 events, `scriptRemovedFocus: []`) was walked for every real
 * `focusin`→`focusout` pair sharing an id — 24 of them, ordinary Tab transitions, none scripted — and the
 * SMALLEST gap measured was 633 ms. That is **a 12.6x margin on the negative side, lower bound
 * unconfirmed**: 633 ms is an actual observed focusout-follows-Tab-press gap, not an upper bound derived
 * from a probe's mean, so it tightens the negative-side evidence beyond the 38.9x figure above rather than
 * merely repeating it. It says nothing new about the other side — no capture has yet recorded a script
 * `blur()` at all, so whether a real synchronous re-focus lands under 50 ms remains exactly as unmeasured
 * as the paragraph above already says. Both figures bound the SAME side; neither touches the lower one.
 *
 * So the SEPARATION is real and evidenced, twice over, on the negative side. What is still unmeasured is
 * the other side: no capture has yet recorded a script `blur()` to confirm it lands under 50 ms rather
 * than merely under 633. The first capture carrying a real F55 page settles that, and until one does this
 * threshold is a hypothesis with a large margin rather than a calibrated value.
 *
 * THE SEAM THIS CLOSED, 2026-09-06: `choosePageTarget` picking the wrong CDP target — the Cookiebot-iframe
 * shape `censusTargetIsSuspect` (`packages/evidence/src/verify.ts`) exists for — reaches this detector
 * through the identical `pageTarget()` machinery the census reads, and until now nothing here checked it.
 * `evaluateOnPageTarget` (`browser-session.mjs`) always computed `targetMatch`/`candidates`;
 * `collectFocusEventLog` passed `targetMatch` on but silently dropped `candidates`; this function did not
 * even destructure `targetMatch`. So a mistargeted capture correctly suppressed a census finding (`null`,
 * per `censusTargetIsSuspect`) while still reporting a REAL F55 finding computed from focus events on the
 * wrong document — "a remedy applied at ONE call site when the behaviour reaches several", CLAUDE.md's own
 * name for this repo's most expensive recurring defect shape, one seam further along the same pipe.
 *
 * `focusTargetIsSuspect` below is the WORKER-SIDE TWIN of `censusTargetIsSuspect`, not a shared import: this
 * file is `.mjs` running under plain Node on the Windows guest, `verify.ts` is TypeScript compiled to
 * `dist`, and depending on a build from here is how a stale `dist` scored the wrong rules once already (see
 * `name-normalisation.test.ts`'s header). Two copies that CANNOT be merged across that boundary are pinned
 * equal by a test instead — `focus-target-suspect-parity.test.ts` — which is this file's own third remedy
 * for "a fact stated twice": delete the copy (impossible here), derive one from the other (impossible
 * here), so pin them with a test that fails the moment they disagree.
 *
 * @param {{ events: {type: string, id: number, name: string, atMs: number}[] | null | undefined,
 *           error?: string | undefined, targetMatch?: string | null | undefined,
 *           candidates?: number | undefined }} log
 */
export function focusEventVerdict({ events, error, targetMatch, candidates }) {
  if (!Array.isArray(events)) {
    return { asked: true, checked: false, why: error || "no event log", scriptRemovedFocus: null };
  }
  if (focusTargetIsSuspect({ targetMatch, candidates })) {
    // "Cannot say", never "no findings" -- identical to the no-log branch above, and for the same reason:
    // a verdict computed from the wrong document is not evidence about the right one. `mapping: "secondary"`
    // in `rules.ts` already means a referral rather than an assertion, but a wrong referral is still wrong.
    return {
      asked: true, checked: false,
      why: `focus-event log target unconfirmed (targetMatch=${targetMatch}, candidates=${candidates})`,
      scriptRemovedFocus: null,
    };
  }
  const scriptRemovedFocus = [];
  for (let i = 0; i < events.length - 1; i += 1) {
    const receipt = events[i];
    const next = events[i + 1];
    const heldMs = next?.atMs - receipt?.atMs;
    if (receipt?.type === "focusin" && next?.type === "focusout" && receipt.id === next.id
      && heldMs < FOCUS_SCRIPT_BLUR_WINDOW_MS) {
      scriptRemovedFocus.push({ id: receipt.id, name: receipt.name, heldMs });
    }
  }
  return { asked: true, checked: true, events: events.length, scriptRemovedFocus };
}

/**
 * The plain boolean probe flags the worker's request boundary accepts.
 *
 * LIVES HERE, NOT IN `server.mjs`, so a test can READ it. `probe-chain.test.ts` used to regex that file
 * for `^    probeX:` lines inside `captureOptions`; extracting those flags into a list on 2026-09-05 --
 * to get the function back under the complexity gate -- reduced the scan to one match, and the suite's own
 * message named the diagnosis: "the scan is broken, not the code clean". A test deriving its expectations
 * from source TEXT is this repo's anti-pattern, and importing `server.mjs` to fix it would start an HTTP
 * server. This module is pure and already exported.
 *
 * NAMED rather than forwarded by prefix, and that is deliberate at THIS hop specifically: it is the
 * REQUEST BOUNDARY, so an unknown `probe*` key arriving over the wire must not become an option the
 * capture acts on. The prefix-forwarding rule applies to the hops between our own code, not to input.
 *
 * `probeOrder` is absent because it is a NAME ("focus-first"), not a boolean.
 */
export const PROBE_FLAGS = Object.freeze([
  "probeForms",
  "probeFocus",
  "probeTables",
  // Activates the first link and asks NVDA for the page title before and after. 2.4.2's single-page-app
  // failure, where the route changes and the title does not.
  "probeNavigation",
  // Cross-check against NVDA's own Elements List totals. Opens a modal dialog on the guest, so it is
  // never on by default.
  "probeElementsList",
  // Presses arrows inside whatever widget the focus probe landed on. Meaningless without `probeFocus`,
  // because browse mode owns the arrows and one pressed there navigates the DOCUMENT.
  "probeArrows",
  // TYPES into the focused field, which changes the page under measurement.
  "probeTyping",
  "probeFocusContext",
  "probeDialog",
  "probeFocusReveal",
]);
