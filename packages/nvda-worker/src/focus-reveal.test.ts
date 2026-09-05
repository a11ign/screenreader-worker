
/**
 * 1.4.13 Content on Hover or Focus — the DISMISSABLE bullet, decided from three censuses and two focus
 * reads. The criterion was recorded `out-of-scope` until 2026-09-05 on the reasoning "the screen-reader
 * path never hovers", which is true of the hover trigger and settles neither of the other two bullets:
 * it covers "pointer hover OR KEYBOARD FOCUS", and we drive keyboard focus.
 */
import { test as focusRevealTest } from "node:test";
import focusRevealAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { focusRevealVerdict, censusGrowth } from "./capture-pure.mjs";

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

/**
 * THE BUG THIS FILE'S SIX TESTS ABOVE COULD NOT SEE, AND WHY IT NEEDED A DIFFERENT KIND OF TEST.
 *
 * All 18 of the 1.4.13 cases came back BLIND from their first capture — 15 corpus plus 3 held-out — while
 * every unit test here passed. They were right to: `focusRevealVerdict` was never wrong. What was wrong is
 * WHERE its evidence came from. `probeFocusReveal` ran after `probeFocusOrder`, which walks the entire tab
 * ring, so the panel the probe exists to catch was already open when it took its "before" census and the
 * delta was zero by construction. Measured on `focus-panel-undismissable-fee.bad`: stop 2 is the trigger,
 * stop 3 is the link inside the `hidden` panel.
 *
 * A verdict function tested on hand-built censuses cannot fail on that, however many cases you give it —
 * which is this repo's own rule that a metric computed on data sharing the flaw cannot see the flaw. The
 * property that was actually broken is an ORDER, so it is the order that has to be asserted.
 *
 * Source text, deliberately and with the anti-vacuity guard that requires: `probePasses` needs real NVDA,
 * so there is nothing to import and call. `forbidden-input-keys-parity.test.ts` documents the same
 * exception for the same reason.
 */
focusRevealTest("the reveal probe is sequenced BEFORE the probe that walks the tab ring", () => {
  // `probePasses`, where both live, moved to `capture-probes.mjs` in the 2026-09-05 split.
  const source = readFileSync(
    resolve(import.meta.dirname, "./capture-probes.mjs"), "utf8");
  const reveal = source.indexOf("results.focusReveal = probeFocusReveal_");
  // Marker updated when `probeFocusOrder`'s call site moved into `probeFocusOrderWithEventLog` (the F55
  // focus-event log, which brackets the tab walk) -- that function IS the probe that walks the tab ring
  // now, `probeFocusOrder` itself being one call inside it. Whatever the marker, the invariant is the one
  // this test's own name states; the marker is just how a source-text test has to find it.
  const order = source.indexOf("await probeFocusOrderWithEventLog");
  focusRevealAssert.ok(reveal >= 0 && order >= 0,
    "one of the two assignments is gone from capture-probes.mjs -- this test examines nothing; find where "
    + "the probes are sequenced now and assert the order there");
  focusRevealAssert.ok(reveal < order,
    "probeFocusReveal must run BEFORE probeFocusOrder. It ran after once, and its baseline census was "
    + "then taken on a page whose whole tab ring had already been focused -- so anything revealed on "
    + "focus was already in the baseline and all 18 of its cases read `revealed: false`.");
});

focusRevealTest("censusGrowth keeps 'we could not look' apart from 'there was nothing'", () => {
  focusRevealAssert.equal(censusGrowth({ error: "no socket" }, GREW), null,
    "an errored census must not read as zero growth");
  focusRevealAssert.equal(censusGrowth(BASE, { error: "no socket" }), null,
    "and it must not, in either position");
  focusRevealAssert.deepEqual(censusGrowth(BASE, BASE), [],
    "an unchanged census is EMPTY growth, which is a real reading and not an absent one");
  focusRevealAssert.deepEqual(censusGrowth(BASE, GREW), [["link", 1]],
    "growth names the role and the size, because the evidence has to say what appeared");
});

focusRevealTest("a role that SHRANK is not growth", () => {
  // Directional on purpose. Content going away while a control takes focus is 1.4.13's PERSISTENT bullet,
  // which `focusRevealVerdict` reports as `vanished` and deliberately does not judge -- folding it in here
  // would make one verdict answer two bullets, which is how a criterion gets reported more confidently
  // than its evidence allows.
  focusRevealAssert.deepEqual(censusGrowth(GREW, BASE), []);
});
