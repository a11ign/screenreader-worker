/**
 * The quick-nav sweep's movement rule.
 *
 * This exists because of a phantom. The sweep used to decide "did NVDA move?" by asking whether
 * `lastSpokenPhrase` differed from a phrase seeded at the start of the sweep. When a jump did NOT move
 * and NVDA said nothing at all, `lastSpokenPhrase` kept returning older text, which differed from the
 * seed, passed every guard, and was recorded as an element that does not exist -- a landmark on a page
 * where NVDA's own Elements List reports "1 of 1".
 *
 * The consequence was not cosmetic. The extra entry changed the evidence text enough to move a
 * conformant page's 3.3.2 score from 0.0039 to 0.3917 across a 0.35 threshold, so the same unchanged
 * page was judged clean in one capture and failing in the next.
 *
 * The rule now: new speech is the only proof of movement. Silence is unambiguous; an unchanged phrase
 * never was.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { sweepStepFromSpeech, MAX_CONSECUTIVE_REPEATS } from "./capture-pure.ts";
import { spendTrip, splitByDirection } from "./capture-probes.ts";

test("silence stops the sweep even when older speech is still in the log", () => {
  // This input is chosen so it DISCRIMINATES. The jump added nothing (log length == seen), and `prev`
  // holds a phrase carried over from the heading sweep that DIFFERS from the log's last entry. Under
  // the old rule, `lastSpokenPhrase` returned that last entry, it differed from `prev`, and it was
  // recorded as a landmark -- the phantom. Had `prev` instead equalled the last entry, the old rule
  // would have stopped too and this test would prove nothing; that near-miss is why it is spelled out.
  const log = ["Cycling guide", "heading, level 1, Cycling guide", "Route safety guidance, heading, level 2"];
  const prev = "Cycle hire, heading, level 1";
  const oldRulePhrase = log[log.length - 1];
  assert.notEqual(oldRulePhrase, prev, "precondition: the old rule must have recorded something here");

  const step = sweepStepFromSpeech({ log, seen: log.length, prev });
  assert.equal(step.stop, "silent");
  assert.equal(step.phrase, undefined, "a silent jump must not yield a phrase to record");
});

test("new speech is reported, and is the LAST entry so evidence matches lastSpokenPhrase", () => {
  // Parity matters concretely: if this returned the join instead, every cached capture's structural
  // fields would change and 2,122 captures would need recapturing for no gain in signal.
  const step = sweepStepFromSpeech({
    log: ["old", "main landmark", "Hire duration, edit"],
    seen: 1,
    prev: "",
  });
  assert.equal(step.phrase, "Hire duration, edit");
  assert.equal(step.seen, 3);
});

test("NVDA's own end-of-document wording stops the sweep", () => {
  for (const wording of ["no next landmark", "no previous heading", "no more headings"]) {
    const step = sweepStepFromSpeech({ log: ["x", wording], seen: 1, prev: "" });
    assert.equal(step.stop, "exhausted", `${wording} should end the sweep`);
  }
});

test("ONE repeated phrase does not stop the sweep — real pages repeat announcements", () => {
  // This asserted the opposite, and that is the defect. A page with 66 images and 47 distinct alt values has
  // four announced "Joe Kearns Avatar", so two adjacent identical announcements are ordinary MOVEMENT. The
  // graphic sweep stopped after 5 items on such a page while its accessibility tree held 66 graphics, and the
  // link sweep — mostly distinct text — reached 52 of 58. It was running into duplicate alt text, not out of
  // page. `spoken` being non-empty already proves the cursor moved; the silent branch catches one that did not.
  const step = sweepStepFromSpeech({ log: ["a", "same"], seen: 1, prev: "same" });
  assert.equal(step.stop, undefined, "one duplicate announcement must not end the sweep");
  assert.equal(step.phrase, "same", "and the element must still be collected");
  assert.equal(step.repeats, 1, "but the run of duplicates is counted");
});

test("THREE consecutive repeats do stop it — that is a wrap or a stuck cursor", () => {
  let repeats = 0;
  let stop;
  for (let i = 0; i < MAX_CONSECUTIVE_REPEATS; i += 1) {
    const step = sweepStepFromSpeech({ log: ["a", "same"], seen: 1, prev: "same", repeats });
    repeats = step.repeats ?? 0;
    stop = step.stop;
  }
  assert.equal(stop, "repeat", `${MAX_CONSECUTIVE_REPEATS} identical announcements in a row is not movement`);
});

test("a DIFFERENT phrase resets the run, so duplicates must be consecutive", () => {
  // Without the reset, scattered duplicates across a long sweep would accumulate to the threshold and stop a
  // sweep that was moving perfectly well — the same over-eager stop in a slower form.
  const step = sweepStepFromSpeech({ log: ["a", "different"], seen: 1, prev: "same", repeats: 2 });
  assert.equal(step.stop, undefined);
  assert.equal(step.repeats, 0, "a new phrase clears the duplicate run");
});

test("a repeat of the SEED does not end a sweep before it starts", () => {
  // `prev` starts empty precisely so a phrase left over from the previous sweep cannot end this one
  // before it starts -- the mirror of the phantom, which would silently truncate the list instead.
  assert.equal(sweepStepFromSpeech({ log: ["a", "b"], seen: 1, prev: "" }).phrase, "b");
});

test("a log that SHRANK is a channel rebuild, not a delta", () => {
  // `ensureSpeechChannel` can destroy and reconnect the socket, which clears the log. Slicing from a
  // stale offset would fabricate a delta out of unrelated phrases, so this must be distinguishable
  // from running out of elements -- hence a named stop rather than a bare break.
  const step = sweepStepFromSpeech({ log: ["fresh"], seen: 9, prev: "" });
  assert.equal(step.stop, "channelReset");
  assert.equal(step.seen, 1, "the offset must resynchronise to the new log");
});

test("blank and whitespace-only utterances do not count as movement", () => {
  assert.equal(sweepStepFromSpeech({ log: ["a", "", "   "], seen: 1, prev: "" }).stop, "silent");
});

test("the sweep mark carries each direction's split", () => {
  // The mark is written inside collectByType, which nothing here runs (it needs NVDA), so this reads the source.
  // The window stops at `phrases:`, so a split moved out of the mark is caught rather than found elsewhere in the file.
  // What the splits CONTAIN is pinned by the behavioural test below, not by this one.
  const source = readFileSync(resolve(import.meta.dirname, "capture-probes.ts"), "utf8");
  const at = source.indexOf('ctx.diag.mark("sweep", {');
  assert.notEqual(at, -1, "the sweep mark must exist");
  const mark = source.slice(at, source.indexOf("phrases:", at));
  for (const split of ["prevSplit:", "nextSplit:"]) {
    assert.equal(mark.split(split).length - 1, 1, `the sweep mark must carry ${split} once`);
  }
  // The edges are the one mapping the behavioural test cannot reach: which snapshot each direction starts and ends on.
  assert.ok(source.includes("splitByDirection(msAtStart, msAfterPrev, ctx.trips)"),
    "the splits must be taken between the start, the far end of the backward walk, and the end");
});

test("each direction's split is the bucket deltas between its own two edges", () => {
  // #1685's instrument. Every bucket gets a different delta, so a swapped bucket, or a direction measured between
  // the wrong edges, changes the result. deepEqual also pins the field names, so a renamed field fails here.
  const atStart = { count: 0, performMs: 0, logMs: 0, quietMs: 0 };
  const afterPrev = { count: 3, performMs: 10, logMs: 20, quietMs: 40 };
  const atEnd = { count: 9, performMs: 15, logMs: 27, quietMs: 100 };
  assert.deepEqual(splitByDirection(atStart, afterPrev, atEnd), {
    prevSplit: { tripPerformMs: 10, tripLogMs: 20, tripQuietMs: 40 },
    nextSplit: { tripPerformMs: 5, tripLogMs: 7, tripQuietMs: 60 },
  });
});

test("a round's wall-clock lands in its own bucket, and a round that throws still spends it", async () => {
  // The source test above proves the three names are in the mark. This one proves the buckets hold time: a
  // `-=` for `+=`, or a helper that writes the wrong bucket, fails here and passes the source test.
  const trips = { count: 0, performMs: 0, logMs: 0, quietMs: 0 };
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  await spendTrip(trips, "performMs", () => wait(30));
  await assert.rejects(spendTrip(trips, "quietMs", async () => { await wait(30); throw new Error("silent"); }), /silent/);
  assert.ok(trips.performMs >= 25, `a 30 ms perform round must spend at least 25 ms, spent ${trips.performMs}`);
  assert.ok(trips.quietMs >= 25, `a 30 ms quiet round that threw must still spend its time, spent ${trips.quietMs}`);
  assert.equal(trips.logMs, 0, "a bucket no round used stays at zero");
});
