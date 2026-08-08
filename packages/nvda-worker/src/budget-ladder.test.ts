/**
 * The budget ladder, asserted rather than assumed.
 *
 * A capture nests inside three deadlines defined in three different files, and nobody had checked they were
 * ordered. The capture budget was 120 s inside a worker hard timeout of 240 s — so captures were cut off
 * less than half way to the limit their own worker tolerated, and the phases that run last lost their
 * evidence. That failure is silent: the capture still returns 200 with a transcript, just without the
 * interaction probes that carry 3.3.1 and 4.1.3.
 *
 * Measured on the W3C survey page, which is where the numbers come from:
 *
 *   read-through      61 s   (89 lines, completed naturally with stopReason `repeatBottom`)
 *   heading+landmark   8 s
 *   formField         43 s   (16 fields, activating controls)
 *   link/list/postSubmit  starved — each returned `deadline` having examined nothing
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  budgetLadderIsSound,
  CAPTURE_HARD_TIMEOUT_DEFAULT_MS,
  DEFAULT_BUDGET_MS,
  POST_READ_RESERVE_MS,
  readThroughDeadline,
  WORST_CASE_STARTUP_MS,
} from "./capture-pure.mjs";

/**
 * The host's per-capture timeout, READ from the file that owns it rather than copied here.
 *
 * A hardcoded copy would keep asserting the old number after somebody lowered the real one, so the ladder
 * would look sound while the outermost rung had moved underneath it — the same silent-drift failure the
 * ladder exists to prevent, reintroduced by its own test. Static parse rather than an import, because that
 * module is a script: `pure-graph.test.ts` sets the precedent for checking a source file by reading it.
 */
const HOST_TIMEOUT_MS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    join(here, "..", "..", "lab", "src", "training", "capture-screenreader-dataset.mjs"), "utf8");
  const match = src.match(/DATASET_CAPTURE_TIMEOUT_MS\s*\|\|\s*(\d+)/);
  if (!match) throw new Error("could not read the host capture timeout — has that constant been renamed?");
  return Number(match[1]);
})();

test("the ladder the shipped constants form is ordered", () => {
  // The whole point. If this fails, some edit has made a capture's own budget exceed what contains it,
  // and the symptom will be truncated evidence rather than an error.
  assert.ok(budgetLadderIsSound({
    budgetMs: DEFAULT_BUDGET_MS,
    hardTimeoutMs: CAPTURE_HARD_TIMEOUT_DEFAULT_MS,
    hostTimeoutMs: HOST_TIMEOUT_MS,
    startupMs: WORST_CASE_STARTUP_MS,
  }), `budget ${DEFAULT_BUDGET_MS} + startup ${WORST_CASE_STARTUP_MS} must fit inside `
    + `hard timeout ${CAPTURE_HARD_TIMEOUT_DEFAULT_MS}, which must fit inside host ${HOST_TIMEOUT_MS}`);
});

test("startup is counted against the hard timeout, because the budget excludes it", () => {
  // The subtlety that makes the arithmetic non-obvious: the capture deadline is taken AFTER NVDA is up, so
  // a cold start (measured at 44 s, once including an NVDA restart) is invisible to the budget and fully
  // visible to the hard timeout. Ignoring it is how a "safe" budget trips the timeout on a cold guest.
  assert.ok(DEFAULT_BUDGET_MS + WORST_CASE_STARTUP_MS < CAPTURE_HARD_TIMEOUT_DEFAULT_MS);
  // And the naive check that omits startup must not be what we rely on: prove it would pass a bad ladder.
  assert.ok(budgetLadderIsSound({
    budgetMs: 270_000, hardTimeoutMs: CAPTURE_HARD_TIMEOUT_DEFAULT_MS, hostTimeoutMs: HOST_TIMEOUT_MS,
    startupMs: 0,
  }), "with startup ignored, an unsafe budget looks fine — which is why startupMs is a parameter");
  assert.equal(budgetLadderIsSound({
    budgetMs: 270_000, hardTimeoutMs: CAPTURE_HARD_TIMEOUT_DEFAULT_MS, hostTimeoutMs: HOST_TIMEOUT_MS,
    startupMs: WORST_CASE_STARTUP_MS,
  }), false, "and why the real check refuses it");
});

test("an inverted ladder is REFUSED, so the guard is known to fire", () => {
  // The exact configuration that shipped: a budget larger than the hard timeout containing it.
  assert.equal(budgetLadderIsSound({
    budgetMs: 300_000, hardTimeoutMs: 240_000, hostTimeoutMs: 300_000, startupMs: 0,
  }), false);
  // A hard timeout the host gives up before is equally broken, from the other end.
  assert.equal(budgetLadderIsSound({
    budgetMs: 60_000, hardTimeoutMs: 400_000, hostTimeoutMs: 300_000, startupMs: 0,
  }), false);
  // And a reserve that does not fit inside the budget would starve the read-through completely.
  assert.equal(budgetLadderIsSound({
    budgetMs: 30_000, hardTimeoutMs: 240_000, hostTimeoutMs: 300_000, startupMs: 0,
  }), false, "the reserve must be smaller than the budget it is carved out of");
});

test("the read-through stops early, leaving the reserve for the phases after it", () => {
  const now = 1_000_000;
  const captureDeadline = now + DEFAULT_BUDGET_MS;
  assert.equal(captureDeadline - readThroughDeadline(captureDeadline, now), POST_READ_RESERVE_MS);
});

test("a small budget scales the reserve down instead of reading nothing", () => {
  // `capture-check` and the unit paths pass short budgets. Subtracting a fixed 60 s from a 10 s budget
  // would put the read deadline in the past, so the read-through would return an empty transcript — which
  // this pipeline reports as "the page announced nothing", the signature of a real failure.
  const now = 1_000_000;
  assert.equal(readThroughDeadline(now + 10_000, now) - now, 5_000, "half of what is left");
  assert.equal(readThroughDeadline(now + 2_000, now) - now, 1_000);
});

test("an already-expired budget is returned unchanged, not pushed further into the past", () => {
  const now = 1_000_000;
  assert.equal(readThroughDeadline(now - 5_000, now), now - 5_000);
  assert.equal(readThroughDeadline(now, now), now);
});

test("the reserve is big enough for the phases it protects", () => {
  // Measured: link 3.6 s + list 3.6 s + postSubmit 4.9 s on the page that starved, and the formField sweep
  // reached 43 s on the same page. The reserve cannot guarantee a huge formField sweep AND the tail, so it
  // is sized for the tail — the part nothing else can produce evidence for.
  const measuredTailMs = 3_600 + 3_600 + 4_900;
  assert.ok(POST_READ_RESERVE_MS > measuredTailMs * 4,
    "the reserve should carry the measured tail several times over, since pages vary");
});
