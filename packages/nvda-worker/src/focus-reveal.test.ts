
/**
 * 1.4.13 Content on Hover or Focus — the DISMISSABLE bullet, decided from three censuses and two focus
 * reads. The criterion was recorded `out-of-scope` until 2026-09-05 on the reasoning "the screen-reader
 * path never hovers", which is true of the hover trigger and settles neither of the other two bullets:
 * it covers "pointer hover OR KEYBOARD FOCUS", and we drive keyboard focus.
 */
import { test as focusRevealTest } from "node:test";
import focusRevealAssert from "node:assert/strict";
import { focusRevealVerdict } from "./capture-pure.mjs";

const BASE = { formControl: 2, link: 3, graphic: 0, heading: 1, landmark: 1 };
const GREW = { ...BASE, link: 4 };

focusRevealTest("a census that failed with an ERROR OBJECT also reads UNKNOWN", () => {
  // THE SHAPE THE FIRST VERSION OF THIS FUNCTION MISSED, and `tsc` caught it rather than a capture run.
  // `structuralCensus` does not return `null` on failure — it returns `{ error }`. So the obvious
  // `if (!before)` guard passed the failure straight through, every count read 0, and a dropped CDP socket
  // became "nothing appeared on focus", which is a conformant page. Absence read as a value, in the one
  // place where absence IS the question.
  const v = focusRevealVerdict({
    before: { error: "no socket" }, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a",
  });
  focusRevealAssert.equal(v.revealed, null, "an errored census is not a reading of zero");
});

focusRevealTest("a failed census reads UNKNOWN, never 'nothing appeared'", () => {
  // The rule this file has paid for more than once: absence read as a value. `structuralCensus` returns
  // null when the CDP socket did not answer, and treating that as zero would turn every dropped connection
  // into a conformant page.
  const v = focusRevealVerdict({ before: null, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, null, "a census that did not answer is not a reading of zero");
  focusRevealAssert.match(String(v.why), /census unavailable/);
});

focusRevealTest("content that appears on focus and survives Escape is the Dismissable failure", () => {
  const v = focusRevealVerdict({ before: BASE, onFocus: GREW, afterEscape: GREW, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, true);
  focusRevealAssert.equal(v.dismissed, false, "Escape did not remove it");
  focusRevealAssert.equal(v.focusHeld, true, "and focus never moved, so Escape is the mechanism being tested");
});

focusRevealTest("content dismissed by Escape while focus HELD is the conformant shape", () => {
  const v = focusRevealVerdict({ before: BASE, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.dismissed, true);
  focusRevealAssert.equal(v.focusHeld, true);
});

focusRevealTest("Escape that MOVED focus dismissed nothing — it navigated", () => {
  // The criterion asks for a mechanism to dismiss "WITHOUT MOVING pointer hover or keyboard focus". A page
  // where Escape moves focus has not demonstrated that mechanism, and reporting `dismissed: true` alone
  // would credit it with one. `focusHeld` is reported separately so a rule can tell the two apart.
  const v = focusRevealVerdict({ before: BASE, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "b" });
  focusRevealAssert.equal(v.focusHeld, false);
  focusRevealAssert.equal(v.vanished, true, "content went while the trigger no longer holds focus");
});

focusRevealTest("nothing appearing on focus is not a finding of any kind", () => {
  const v = focusRevealVerdict({ before: BASE, onFocus: BASE, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, false);
  focusRevealAssert.equal(v.dismissed, undefined, "there is nothing to dismiss, so the bullet does not apply");
});
