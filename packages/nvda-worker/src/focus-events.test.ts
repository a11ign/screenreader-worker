/**
 * F55 — "using script to remove focus when focus is received" (2.1.1, 2.4.7, 2.4.13 and 3.2.1, per W3C's
 * own Failure listing) — decided from a `focusin`/`focusout` log rather than from `focusOrder`, because a
 * control that receives focus and immediately loses it to script produces a tab-stop list IDENTICAL to one
 * that was never focusable at all. See `browser-session.mjs`'s `installFocusEventLog` and
 * `capture-pure.mjs`'s `focusEventVerdict` for the design, including why TIMING and not mere adjacency is
 * the discriminator — the first version of `focusEventVerdict` got that wrong, and the test below titled
 * "ordinary Tab transitions" is the one that caught it.
 */
import { test as focusEventTest } from "node:test";
import focusEventAssert from "node:assert/strict";
import { focusEventVerdict } from "./capture-pure.mjs";

focusEventTest("no event log at all reads 'cannot say', never as zero findings", () => {
  // The rule this whole file exists to enforce, stated once more: `events: null` is "we did not ask" or
  // "the oracle failed", and `focusRevealVerdict` already pays for the cost of collapsing that into a
  // reading of zero. `checked: false` is the field a rule must gate on before trusting `scriptRemovedFocus`.
  const v = focusEventVerdict({ events: null, error: "not installed" });
  focusEventAssert.equal(v.checked, false);
  focusEventAssert.equal(v.scriptRemovedFocus, null, "no oracle means no finding can be stated, not zero");
  focusEventAssert.match(String(v.why), /not installed/);
});

focusEventTest("an installed log with no events is a real reading of zero, not an absent one", () => {
  const v = focusEventVerdict({ events: [] });
  focusEventAssert.equal(v.checked, true);
  focusEventAssert.deepEqual(v.scriptRemovedFocus, [], "the oracle ran and genuinely saw nothing");
});

focusEventTest("ordinary Tab transitions produce NO finding, however adjacent the pair looks", () => {
  // Per the UI Events spec, a Tab transition from A to B fires focusout(A) THEN focusin(B), as one
  // browser-level change -- so A's OWN focusin is followed, a few log entries later, by A's OWN focusout,
  // exactly the shape F55 has. What tells them apart is TIME: this focusout was caused by the NEXT Tab
  // press, which cannot happen until probeFocusOrder's loop sent a keystroke and read NVDA's announcement
  // back -- realistically hundreds of milliseconds, never single digits.
  const events = [
    { type: "focusout", id: 9, name: "previous probe's control", atMs: 0 },
    { type: "focusin", id: 0, name: "First name", atMs: 1 },
    { type: "focusout", id: 0, name: "First name", atMs: 850 }, // caused by the NEXT tab press, not by id 0
    { type: "focusin", id: 1, name: "Last name", atMs: 851 },
    { type: "focusout", id: 1, name: "Last name", atMs: 1600 },
    { type: "focusin", id: 2, name: "Submit", atMs: 1601 },
  ];
  const v = focusEventVerdict({ events });
  focusEventAssert.equal(v.checked, true);
  focusEventAssert.deepEqual(v.scriptRemovedFocus, [],
    "every focusin-then-focusout pair here is hundreds of ms apart -- a human/pipeline-paced Tab cycle, "
      + "not a script's synchronous blur");
});

focusEventTest("focusin immediately followed by focusout on the SAME id, WITHIN the window, is F55", () => {
  const events = [
    { type: "focusout", id: 9, name: "previous", atMs: 0 },
    { type: "focusin", id: 0, name: "First name", atMs: 1 },
    { type: "focusout", id: 0, name: "First name", atMs: 850 },
    // id 1 receives focus via Tab and script blurs it in the SAME task -- a 2ms gap, not the ~800ms an
    // actual Tab-press round trip takes elsewhere in this same log.
    { type: "focusin", id: 1, name: "Promo code", atMs: 851 },
    { type: "focusout", id: 1, name: "Promo code", atMs: 853 },
    { type: "focusin", id: 2, name: "Submit", atMs: 1600 },
  ];
  const v = focusEventVerdict({ events });
  focusEventAssert.equal(v.scriptRemovedFocus?.length, 1);
  focusEventAssert.equal(v.scriptRemovedFocus?.[0].id, 1);
  focusEventAssert.equal(v.scriptRemovedFocus?.[0].name, "Promo code");
  focusEventAssert.equal(v.scriptRemovedFocus?.[0].heldMs, 2, "how long focus was actually held, in ms");
});

focusEventTest("matched by id, never by name -- two DIFFERENT controls sharing a name is not F55", () => {
  // `unambiguous` (rules.ts) exists because a page routinely has two controls with the same name (two
  // "Submit" buttons in two forms). A verdict keyed on name would read this ordinary, slowly-paced
  // transition between two same-named controls as one control losing the focus it just received.
  const events = [
    { type: "focusin", id: 0, name: "Submit", atMs: 10 },
    { type: "focusout", id: 0, name: "Submit", atMs: 900 },
    { type: "focusin", id: 1, name: "Submit", atMs: 901 },
  ];
  const v = focusEventVerdict({ events });
  focusEventAssert.deepEqual(v.scriptRemovedFocus, [],
    "different ids, same name, ~900ms apart -- an ordinary Tab transition, not F55");
});

focusEventTest("more than one control can exhibit F55 in the same capture, and both are reported", () => {
  const events = [
    { type: "focusin", id: 0, name: "Coupon", atMs: 10 },
    { type: "focusout", id: 0, name: "Coupon", atMs: 11 },
    { type: "focusin", id: 1, name: "Gift card", atMs: 500 },
    { type: "focusout", id: 1, name: "Gift card", atMs: 501 },
  ];
  const v = focusEventVerdict({ events });
  focusEventAssert.deepEqual(v.scriptRemovedFocus?.map((f) => f.name), ["Coupon", "Gift card"]);
});

focusEventTest("a lone focusout with nothing preceding it is not a finding", () => {
  // `anchorToTop`'s own Escape/Ctrl+Home can blur whatever a PRIOR probe (focusContext, focusReveal) left
  // focused, before this log was installed for `probeFocusOrder` specifically -- so the log can legitimately
  // open on a bare focusout with no matching focusin in it at all. That must read as "nothing to pair",
  // not crash and not false-positive.
  const events = [{ type: "focusout", id: 0, name: "Whatever a prior probe focused", atMs: 5 }];
  const v = focusEventVerdict({ events });
  focusEventAssert.equal(v.checked, true);
  focusEventAssert.deepEqual(v.scriptRemovedFocus, []);
});

focusEventTest("events count is reported alongside the verdict, so a capture can say how much it saw", () => {
  const events = [
    { type: "focusin", id: 0, name: "a", atMs: 1 },
    { type: "focusout", id: 0, name: "a", atMs: 2 },
  ];
  const v = focusEventVerdict({ events });
  focusEventAssert.equal(v.events, 2);
});
