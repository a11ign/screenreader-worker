/**
 * THE CAPTURE SAYS WHICH QUESTION IT ANSWERED — #812.
 *
 * `probeDisclosure` records `after` from `reportCurrentFocus`: **whatever holds focus after activation**,
 * not a re-read of the control that was activated. For 2,000+ corpus captures those were the same thing,
 * because activating a disclosure left focus put. On the V1 rehearsal's nav menu they were not, and the
 * judge asserted 4.1.2 across two different controls that happened to share the word `collapsed`.
 *
 * The comment above that function claimed *"we RE-READ the control"* and *"asks the accessibility tree"*
 * for as long as it existed, and the code never did either. **A comment naming the intent above code that
 * does something adjacent** is this repository's most expensive shape, and the remedy is a FIELD, which a
 * consumer can read, rather than better prose, which it cannot.
 *
 * READ FROM THE SOURCE, the `activation-gates.test.ts` exemption: this package imports guidepup and
 * throws at module load where no screen reader exists, so no test can call `probeDisclosure`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8");
const PROBE = SOURCE.slice(SOURCE.indexOf("async function probeDisclosure"));
const BODY = PROBE.slice(0, PROBE.indexOf("\n}\n"));

test("every stateChanges entry records where `after` came from", () => {
  // BOTH PATHS. The catch branch records an entry too -- deliberately, because a failed measurement is
  // not silence -- and an entry without the field there would be the one case a consumer cannot classify.
  const pushes = [...BODY.matchAll(/interaction\.stateChanges\.push\(([^;]*)\);/g)].map((m) => m[1]);
  assert.equal(pushes.length, 2, `expected the success and error pushes, found ${pushes.length}`);
  for (const push of pushes) {
    assert.match(push, /afterSource:\s*"focus"/,
      "a stateChanges entry that does not say where `after` came from is one the judge must treat as "
      + "unknown provenance — which is the conservative branch, but it is a fact the capture knows");
  }
});

test("the comment no longer claims a re-read of the control or the accessibility tree", () => {
  // The claim is what made the judge's assumption look safe. It is gone; if it comes back, so does the
  // defect, and nothing else in the tree would notice.
  const header = SOURCE.slice(SOURCE.indexOf("// Activate a disclosure"),
    SOURCE.indexOf("async function probeDisclosure"));
  assert.doesNotMatch(header, /re-?read the control|asks the accessibility tree/i,
    "the code calls reportCurrentFocus and does not re-read the activated control");
  assert.match(header, /the FOCUSED control after/,
    "the header must say what `after` actually is");
});

test("`after` still comes from the focus read, so the field is not describing something else", () => {
  // The field and the call must not drift apart: `afterSource: "focus"` beside a changed reader would be
  // a fact stated in a field and contradicted by the line above it.
  assert.match(BODY, /const after = await reportFocusedControlWithRetry\(/);
});
