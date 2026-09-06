/**
 * `focusEventVerdict` (`capture-pure.mjs`) is a PASSTHROUGH as of 2026-09-06: it reports the bounded
 * `focusin`/`focusout` log `probeFocusOrder` installs (via `browser-session.mjs`'s `installFocusEventLog`)
 * and decides nothing about F55. The pairing/orphan/destination analysis that used to live here moved to
 * `addFocusEventFindings` (`packages/judge/src/rules.ts`) — see that function's own doc comment for why,
 * including the two real captures (one conformant, one a genuine positive) that refuted two capture-side
 * designs in one night before this shape was reached. Its tests live in `rules.test.ts`, against the real
 * event sequences.
 *
 * What stays worth testing here is everything this file still controls: absence-vs-zero, the bound, and
 * the target-suspect gate it shares with the census (`focus-target-suspect-parity.test.ts`).
 */
import { test as focusEventTest } from "node:test";
import focusEventAssert from "node:assert/strict";
import { focusEventVerdict } from "./capture-pure.mjs";

focusEventTest("no event log at all reads 'cannot say', never as zero findings", () => {
  const v = focusEventVerdict({ events: null, error: "not installed" });
  focusEventAssert.equal(v.checked, false);
  focusEventAssert.equal(v.log, null, "no oracle means no evidence can be stated, not an empty log");
  focusEventAssert.match(String(v.why), /not installed/);
});

focusEventTest("an installed log with no events is a real reading of zero, not an absent one", () => {
  const v = focusEventVerdict({ events: [] });
  focusEventAssert.equal(v.checked, true);
  focusEventAssert.deepEqual(v.log, [], "the oracle ran and genuinely saw nothing");
});

focusEventTest("the log is passed through verbatim, in order -- no pairing or filtering happens here any more", () => {
  const events = [
    { type: "focusin", id: 0, name: "First name", atMs: 1 },
    { type: "focusout", id: 0, name: "First name", atMs: 850 },
    { type: "focusin", id: 1, name: "Last name", atMs: 851 },
  ];
  const v = focusEventVerdict({ events });
  focusEventAssert.equal(v.checked, true);
  focusEventAssert.deepEqual(v.log, events);
  focusEventAssert.equal(v.events, 3, "the count travels alongside the log, not instead of it");
});

focusEventTest("the log is bounded, so a runaway page cannot make a capture unboundedly large", () => {
  const events = Array.from({ length: 350 }, (_, i) => ({ type: i % 2 === 0 ? "focusin" : "focusout",
    id: Math.floor(i / 2), name: `control ${Math.floor(i / 2)}`, atMs: i }));
  const v = focusEventVerdict({ events });
  focusEventAssert.equal(v.events, 350, "the COUNT reports the true total, even when the log itself is capped");
  focusEventAssert.equal(v.log?.length, 300, "the stored log caps at FOCUS_EVENT_LOG_LIMIT");
  focusEventAssert.deepEqual(v.log?.[0], events[0], "the cap keeps the FIRST events, not a sample");
  focusEventAssert.equal(v.truncated, true,
    "an overflowing page must say so -- a busy real page (296 events) proved 50 too low, and the field is "
    + "what stops the NEXT ceiling from lying the same way");
});

focusEventTest("a log under the cap reports truncated: false, not merely an absent field", () => {
  const events = [
    { type: "focusin", id: 0, name: "First name", atMs: 1 },
    { type: "focusout", id: 0, name: "First name", atMs: 850 },
  ];
  const v = focusEventVerdict({ events });
  focusEventAssert.equal(v.truncated, false, "under the cap is a real, checked 'no' -- not silence");
});

// THE SEAM WITH THE CENSUS'S OWN GUARD, closed 2026-09-06. `choosePageTarget` picking the wrong CDP target
// -- the Cookiebot-iframe shape `censusTargetIsSuspect` exists for -- reaches this detector through the
// same `pageTarget()` machinery, and until now nothing here checked it: a mistargeted capture correctly
// suppressed a census finding while still reporting a real-looking F55 finding computed from focus events
// on the wrong document. See `focusTargetIsSuspect`'s own comment in `capture-pure.mjs` for the full trace.
const SOME_EVENTS = [
  { type: "focusin", id: 0, name: "Coupon", atMs: 10 },
  { type: "focusout", id: 0, name: "Coupon", atMs: 11 },
];

focusEventTest("a mistargeted log (fallback, several candidates) is 'cannot say', regardless of its contents", () => {
  const v = focusEventVerdict({ events: SOME_EVENTS, targetMatch: "fallback", candidates: 3 });
  focusEventAssert.equal(v.checked, false,
    "a log read from the wrong document is not evidence about the right one");
  focusEventAssert.equal(v.log, null, "cannot say, never a suppressed-but-real log");
  focusEventAssert.match(String(v.why), /target unconfirmed/);
});

focusEventTest("fallback with exactly one candidate is NOT suspect -- fallback IS the only page there was", () => {
  const v = focusEventVerdict({ events: SOME_EVENTS, targetMatch: "fallback", candidates: 1 });
  focusEventAssert.equal(v.checked, true, "a guard that suppresses everything is not a guard");
  focusEventAssert.deepEqual(v.log, SOME_EVENTS);
});

focusEventTest("a MATCHED target still reports the log, however many other pages were open", () => {
  const v = focusEventVerdict({ events: SOME_EVENTS, targetMatch: "matched", candidates: 5 });
  focusEventAssert.equal(v.checked, true);
  focusEventAssert.deepEqual(v.log, SOME_EVENTS);
});

focusEventTest("targetMatch absent entirely (every capture before this field existed) is not retroactively suspect", () => {
  const v = focusEventVerdict({ events: SOME_EVENTS });
  focusEventAssert.equal(v.checked, true);
  focusEventAssert.deepEqual(v.log, SOME_EVENTS);
});
