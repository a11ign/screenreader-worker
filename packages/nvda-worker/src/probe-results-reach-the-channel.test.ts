/**
 * EVERY PROBE RESULT MUST REACH THE CHANNEL, AND FOUR HOPS CAN EACH DROP ONE SILENTLY.
 *
 * `probePasses` computes probe results into a `results` object; `interactionEvidence` REBUILDS the
 * interaction channel from named fields. Between them sit two more hops that name every field again. A
 * field missing from any of the four is silently dropped, and the capture then looks exactly like a page
 * with nothing to report — `interactionEvidence`'s own docstring says so, citing `postSubmitFields` empty
 * on all 2,122 captures.
 *
 * IT HAPPENED AGAIN WHILE THAT DOCSTRING WAS SITTING THERE. `focusReveal` was computed, written to its
 * diagnostic mark, and dropped at every one of the four hops, so `interaction.focusReveal` was `undefined`
 * on every capture and all 18 of the 1.4.13 cases read BLIND. The mark had `revealed: true, dismissed:
 * false` on the bad page and `dismissed: true` on the good one — the discrimination was real, correct, and
 * never reached the channel the signal reads. Diagnosed 2026-09-05 from a capture, not from a test,
 * because no test could see it.
 *
 * A COMMENT WARNING ABOUT A DEFECT DOES NOT PREVENT IT. This asserts the containment instead.
 *
 * Source text, with the anti-vacuity guards that requires: `probePasses` and `interactionEvidence` are
 * internal to a module that needs real NVDA, so there is nothing to import and call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "./capture-core.mjs"), "utf8");

/** Everything `probePasses` assigns a probe result to. */
function resultKeysAssigned(): string[] {
  return [...new Set([...SOURCE.matchAll(/\bresults\.([A-Za-z]\w*)\s*=/g)].map((m) => m[1]))];
}

/** The body of `interactionEvidence`'s returned object literal. */
function interactionEvidenceReturn(): string {
  const start = SOURCE.indexOf("function interactionEvidence({");
  assert.ok(start >= 0,
    "interactionEvidence is gone from capture-core.mjs -- this test examines nothing; find what rebuilds "
    + "the interaction channel now and assert against that");
  const from = SOURCE.indexOf("return {", start);
  const to = SOURCE.indexOf("\n}", from);
  assert.ok(from > start && to > from, "interactionEvidence no longer returns an object literal here");
  // COMMENTS STRIPPED, and this is the whole difference between a guard and a decoration. Every field in
  // that return sits under a comment explaining why it is conditional, and those comments NAME the field —
  // so matching the raw slice matched the prose and passed with the code removed. Caught by mutation:
  // deleting the `focusReveal` spread left the test green until this line existed.
  return SOURCE.slice(from, to).replace(/\/\/[^\n]*/g, "");
}

test("every probe result assigned in probePasses is forwarded by interactionEvidence", () => {
  const assigned = resultKeysAssigned();
  const forwarded = interactionEvidenceReturn();
  // ANTI-VACUITY, both sides. An extraction that stopped matching would compare two empty sets and pass.
  assert.ok(assigned.length >= 5,
    `only ${assigned.length} result assignment(s) found; probePasses no longer writes results.<name> = and `
    + "this test is not examining what it claims to");
  assert.ok(forwarded.length > 200, "the extracted return body is too short to be the real one");

  const dropped = assigned.filter((key) => !new RegExp(`\\b${key}\\b`).test(forwarded));
  assert.deepEqual(dropped, [],
    `probePasses computes ${JSON.stringify(dropped)} and interactionEvidence does not forward it, so the `
    + "value is dropped and `interaction.<name>` is undefined on every capture. That looks identical to a "
    + "page with nothing to report, which is how focusReveal read BLIND on all 18 of its cases.");
});

test("the hops between them name the field too", () => {
  // The middle two hops re-name every field, so forwarding at the ends is not enough. Checked separately
  // because a field present at both ends and missing in the middle is a ReferenceError-free silent
  // `undefined` — the shape that makes this class invisible.
  const assigned = resultKeysAssigned();
  const assemble = SOURCE.slice(SOURCE.indexOf("function assembleAndMark({"));
  const head = assemble.slice(0, assemble.indexOf("diag.mark("));
  assert.ok(head.includes("interactionEvidence({"),
    "assembleAndMark no longer calls interactionEvidence -- the hop this guards has moved");
  const missing = assigned.filter((key) => !new RegExp(`\\b${key}\\b`).test(head));
  assert.deepEqual(missing, [],
    `assembleAndMark does not name ${JSON.stringify(missing)}, so it arrives at interactionEvidence as `
    + "undefined however carefully that function forwards it");
});
