/**
 * #635: `waitForSpeechQuiet`'s per-iteration verdict, and the rule it exists to enforce.
 *
 * The function used to fold a FAILED read of the speech log into the same variable a genuinely empty
 * read used (`.catch(() => [])`), so a run of failures read as an unchanging log and reported
 * `quiet: true` after one `SPEECH_QUIET_WINDOW_MS` -- indistinguishable from NVDA genuinely finishing
 * speaking. That is the "a dead speech channel looks like a healthy silent NVDA" shape docs/adr/0034
 * names as this project's single most expensive fault class, recurring here in a spot that bypasses
 * `ensureSpeechChannel`'s fix.
 *
 * `speechQuietStep` is the isolated per-iteration decision, extracted to `capture-pure.mjs` so it is
 * directly testable without guidepup -- `tests-run-without-a-screen-reader.test.ts` refuses any test
 * that reaches it.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { speechQuietStep } from "./capture-pure.mjs";

const QUIET_WINDOW_MS = 300;

test("MUTATION TARGET: a run of FAILED reads never reports quiet, however long it runs", () => {
  // The exact shape that cost this project the most: a dead channel, read repeatedly, must never look
  // like settled silence. `length`/`lastChange` never move past their starting point on a failed read.
  let length = -1;
  let lastChange = 0;
  for (let at = 0; at <= QUIET_WINDOW_MS * 3; at += 50) {
    const step = speechQuietStep({ readOk: false, now: 0, length, lastChange, at, quietWindowMs: QUIET_WINDOW_MS });
    assert.equal(step.quiet, false, `a failed read at t=${at}ms must never close the quiet window`);
    length = step.length;
    lastChange = step.lastChange;
  }
});

test("a genuinely unchanging, SUCCESSFUL log closes the window once it has held for quietWindowMs", () => {
  let step = speechQuietStep({ readOk: true, now: 3, length: -1, lastChange: 0, at: 0, quietWindowMs: QUIET_WINDOW_MS });
  assert.equal(step.quiet, false, "the first successful read establishes a baseline, not quiet yet");
  assert.equal(step.length, 3);
  const { length, lastChange } = step;
  step = speechQuietStep({ readOk: true, now: 3, length, lastChange, at: QUIET_WINDOW_MS - 1, quietWindowMs: QUIET_WINDOW_MS });
  assert.equal(step.quiet, false, "not yet -- the window has not fully elapsed");
  step = speechQuietStep({ readOk: true, now: 3, length, lastChange, at: QUIET_WINDOW_MS, quietWindowMs: QUIET_WINDOW_MS });
  assert.equal(step.quiet, true, "the window has held with successful, unchanging reads -- this IS the finding");
});

test("a successful read that DIFFERS resets the window, exactly as before this fix", () => {
  const step = speechQuietStep({ readOk: true, now: 4, length: 3, lastChange: 0, at: QUIET_WINDOW_MS, quietWindowMs: QUIET_WINDOW_MS });
  assert.equal(step.quiet, false, "new speech arrived -- not quiet");
  assert.equal(step.length, 4, "the new length becomes the baseline");
  assert.equal(step.lastChange, QUIET_WINDOW_MS, "the window restarts from the moment of the change");
});

test("a failed read leaves length and lastChange untouched, so a later SUCCESSFUL run still needs its own full window", () => {
  // If a failure silently advanced `lastChange`, an attacker-shaped sequence of fail,fail,success,success
  // could close the window on far less than a real quiet period. Confirm failures are inert, not merely
  // non-positive.
  const afterFailure = speechQuietStep(
    { readOk: false, now: 0, length: 3, lastChange: 100, at: 150, quietWindowMs: QUIET_WINDOW_MS });
  assert.deepEqual({ length: afterFailure.length, lastChange: afterFailure.lastChange }, { length: 3, lastChange: 100 },
    "a failed read must not move the baseline it inherited");
});

test("a failed read followed by a matching successful read is judged from the ORIGINAL lastChange, "
  + "since nothing about the failure changed what was last known", () => {
  const step = speechQuietStep(
    { readOk: true, now: 3, length: 3, lastChange: 0, at: QUIET_WINDOW_MS, quietWindowMs: QUIET_WINDOW_MS });
  assert.equal(step.quiet, true, "the successful read still matches the pre-failure baseline and the "
    + "window has genuinely elapsed since the last real change");
});
