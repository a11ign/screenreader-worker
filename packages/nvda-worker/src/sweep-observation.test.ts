/**
 * "We asked and the page has none" and "nobody asked" must never be the same value.
 *
 * That conflation is the most expensive shape in this repo's record: `landmark_present` was DELETED because
 * 16 of its 16 zeros were truncated sweeps, `postSubmitFields` read `[]` on all 2,122 captures with 604
 * logged crashes behind it, and `table_present` reads 0 on 6,095 captures where the probe never ran. Ten of
 * the 28 model features read only channels with this ambiguity.
 *
 * So these assert the three states are DISTINGUISHABLE, not that the helpers return something.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { notObserved, sweepObservation } from "./capture-pure.mjs";

test("a sweep NVDA ended itself is complete — `exhausted` is its own answer", () => {
  // NVDA says "no next heading" when there are none left. That is the only sound terminus, because every
  // other one is the sweep giving up rather than the page running out.
  const seen = sweepObservation({ stop: "exhausted" }, { stop: "exhausted" });
  assert.equal(seen.asked, true);
  assert.equal(seen.complete, true);
});

test("ONE direction giving up is enough to make it incomplete", () => {
  // `collectByType` walks backwards then forwards and merges them, so a half-swept page has one exhausted
  // direction. Reading that as complete is the truncation-as-absence defect this field exists to remove.
  for (const stop of ["deadline", "repeat", "silent", "cap", "error", "focusModeStuck"]) {
    assert.equal(sweepObservation({ stop: "exhausted" }, { stop }).complete, false, `next=${stop}`);
    assert.equal(sweepObservation({ stop }, { stop: "exhausted" }).complete, false, `prev=${stop}`);
  }
});

test("a sweep with no outcome at all says `unknown`, never `exhausted`", () => {
  // Absence read as agreement is the defect named in `verify.ts`: "census.heading absent read as zero,
  // sameState undefined read as false, a recovery metric read with ?? 0".
  const seen = sweepObservation(undefined, null);
  assert.equal(seen.complete, false);
  assert.deepEqual(seen.stop, { prev: "unknown", next: "unknown" });
});

test("NOT ASKED is a different shape from asked-and-found-nothing", () => {
  const asked = sweepObservation({ stop: "exhausted" }, { stop: "exhausted" });
  const never = notObserved("probeTables is opt-in and this case did not ask");
  assert.equal(asked.asked, true);
  assert.equal(never.asked, false);
  assert.notDeepEqual(asked, never,
    "if these can ever be equal, the whole field is decoration — that is the `any([])` defect in a new place");
});

test("a not-observed channel must say WHY, because there is more than one reason", () => {
  // "the probe is opt-in and this case did not request it" and "the page had no control to activate" are
  // different facts. A reader who cannot tell them apart is back where they started.
  assert.equal(typeof notObserved("no control was activated, so no state could change").why, "string");
  // @ts-expect-error — the reason is required, not defaulted
  assert.equal(notObserved().why, undefined);
});

test("EVERY channel a capture fills must be able to report an observation", () => {
  // The omission that made this test necessary: `sweepExtraTypes` was called without `observed`, so
  // `links`, `lists` and `graphics` had no observation at all — and an ABSENT observation reads exactly
  // like an unasked one, which made the gap invisible in the very field built to make gaps visible.
  //
  // Found by reading a real capture, not by a green pipeline: `verify` passed, `check-signals` passed, and
  // three channels were silently unaccounted for. Asserted against the SOURCE because `capture-core.mjs`
  // imports guidepup and cannot be loaded here — the same reason `probe-chain.test.ts` reads it as text.
  const source = readFileSync(new URL("./capture-core.mjs", import.meta.url), "utf8");
  const call = /sweepExtraTypes\(\{[^}]*\}\)/.exec(source);
  assert.ok(call, "sweepExtraTypes is no longer called the way this guard reads it");
  assert.match(call[0], /\bobserved\b/,
    "the extra sweeps fill links, lists and graphics; without `observed` those three channels can never "
    + "say whether anyone asked");
});
