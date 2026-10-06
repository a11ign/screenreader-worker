// The rules that end a read-through.
//
// Two reasons this is tested rather than trusted. It decides how much of a page gets into the
// transcript, and truncating a transcript is the failure mode this project cannot see from the
// outside: a readiness gate once deleted the h1 announcement from every page and every check stayed
// green because the phrase COUNT had not moved. And the silence rule added here is new, so the
// existing rules need a regression net proving the refactor around it changed nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { phraseAction } from "./capture-pure.mjs";

/** A fresh read-through's running state. `silentAtStart` is what NVDA did before the walk began. */
const tracker = (silentAtStart = false) => ({
  seen: new Set<string>(), previous: null as string | null,
  repeated: 0, wrapRun: 0, silentRun: 0, silentAtStart,
});

const LONG = "a phrase comfortably longer than the dedupe threshold";

test("an ordinary phrase is kept", () => {
  assert.equal(phraseAction("heading, level 1, Museum", 0, tracker()), "keep");
});

test("silence is skipped, not stopped, when NVDA spoke at startup", () => {
  // The safety property. A healthy capture must behave exactly as it did before the silence rule
  // existed, however many empty reads a page produces.
  const state = tracker(false);
  for (let i = 0; i < 40; i++) {
    assert.equal(phraseAction("", 1, state), "skip", `empty read ${i} must not end a healthy read-through`);
  }
});

test("silence ends the read once NVDA was also mute at startup", () => {
  const state = tracker(true);
  const actions = Array.from({ length: 8 }, () => phraseAction("", 0, state));
  assert.deepEqual(actions.slice(0, 7), Array(7).fill("skip"), "must not give up on the first few");
  assert.equal(actions[7], "silent");
});

test("silence never ends the read once the page has actually been heard", () => {
  // heard > 1 means the transcript has real content, so this is a page with gaps, not a mute.
  const state = tracker(true);
  for (let i = 0; i < 40; i++) assert.equal(phraseAction("", 2, state), "skip");
});

test("a spoken phrase resets the silence count", () => {
  // Otherwise a page with scattered empty reads would accumulate its way to a false mute.
  const state = tracker(true);
  for (let i = 0; i < 7; i++) phraseAction("", 0, state);
  assert.equal(phraseAction("something", 0, state), "keep");
  assert.equal(phraseAction("", 0, state), "skip", "the count must have started again");
});

test("three identical lines in a row is the bottom of the page", () => {
  const state = tracker();
  assert.equal(phraseAction("same", 0, state), "keep");
  assert.equal(phraseAction("same", 1, state), "skip");
  assert.equal(phraseAction("same", 1, state), "skip");
  assert.equal(phraseAction("same", 1, state), "repeatBottom");
});

test("four already-seen substantial lines in a row is a wrap-around", () => {
  const state = tracker();
  phraseAction(LONG, 0, state);
  const alternate = LONG + " two";
  // Alternating keeps `previous` changing, so this exercises the wrap rule rather than the repeat rule.
  phraseAction(alternate, 1, state);
  const actions = [LONG, alternate, LONG, alternate].map((p, i) => phraseAction(p, 2 + i, state));
  assert.deepEqual(actions.slice(0, 3), ["skip", "skip", "skip"]);
  assert.equal(actions[3], "wrap");
});

test("short phrases are never deduped, however often they recur", () => {
  // Only phrases past the dedupe threshold are tracked, because short ones like "blank" or "button"
  // legitimately repeat all over a page and losing them would thin the transcript. Alternated here so
  // each differs from the last — identical lines in a row are the bottom-of-page rule, tested above.
  const state = tracker();
  for (let i = 0; i < 10; i++) {
    assert.equal(phraseAction(i % 2 ? "blank" : "button", i, state), "keep");
  }
  assert.equal(state.wrapRun, 0, "short phrases must not accumulate wrap pressure");
  assert.equal(state.seen.size, 0, "short phrases must not enter the dedupe set");
});
