/**
 * THE PER-FIELD ACTIVATION GETS ITS OWN BUDGET — #677 part 2.
 *
 * `formField` is the third of eight sweeps and the only one carrying an `onItem`, and that `onItem`
 * activates a control, presses Escape and waits for speech. On
 * `runs/witness/2026-09-09T08-20-19-020Z-www-ikea-com.json` it spent 322 of 471 seconds on 100 fields and
 * the five sweeps after it — `graphic`, `link`, `list`, `frame`, `postSubmit` — each returned
 * `deadline` having examined nothing. Two structural types out of eight, and `postSubmit` is where 3.3.1
 * and 4.1.3 live.
 *
 * These are the PURE half. `capture-probes.mjs` cannot be unit-tested at all — it imports guidepup and
 * throws at module load where no screen reader exists — so everything decidable lives here and the wiring
 * is guarded by reading the source, the `activation-gates.test.ts` exemption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVATION_SHARE_OF_REMAINING, activationBudgetMark, activationDeadline,
} from "./capture-pure.mjs";

test("the activation may take at most its share, and the sweeps after it keep the rest", () => {
  const now = 1_000_000;
  const captureDeadline = now + 400_000;
  const stops = activationDeadline(captureDeadline, now);

  assert.equal(stops, now + 200_000);
  // THE LOAD-BEARING PROPERTY, stated as the thing that starved rather than as the arithmetic: whatever
  // the share is, what is LEFT for graphic/link/list/frame/postSubmit must not be less than it.
  const leftForTheRest = captureDeadline - stops;
  assert.ok(leftForTheRest >= 200_000,
    `the five sweeps after formField were left ${leftForTheRest} ms; on the IKEA capture they got 0`);
});

test("a budget that has already run out stops the activation immediately, not in the past", () => {
  // Scales down rather than going negative, the same way `readThroughDeadline` does: a deadline in the
  // past and a deadline of "now" behave identically at the call site, but only one of them is a fact.
  const now = 1_000_000;
  assert.equal(activationDeadline(now, now), now);
  assert.equal(activationDeadline(now - 5_000, now), now - 5_000,
    "with the capture deadline already gone, the activation deadline IS it — the next check skips");
  assert.ok(activationDeadline(now + 1, now) >= now);
});

test("the share is a fraction of what REMAINS, not of the whole budget", () => {
  // The activation starts after startup and the read-through, so a share of `DEFAULT_BUDGET_MS` would
  // hand it time that is already spent. Measured from the clock at the moment its sweep begins.
  const now = 1_000_000;
  const early = activationDeadline(now + 400_000, now) - now;
  const late = activationDeadline(now + 100_000, now) - now;
  assert.ok(late < early, "a capture that has already used most of its budget grants a smaller share");
  assert.equal(late, 50_000);
});

test("the share is one number, and it is the one that moves", () => {
  // A second knob (an absolute ceiling) would be a constant with no measurement behind it. If the fleet
  // says half is wrong, this is what changes — so it is asserted, not merely defined.
  assert.equal(ACTIVATION_SHARE_OF_REMAINING, 0.5);
  const now = 0;
  assert.equal(activationDeadline(1_000, now), Math.floor(1_000 * ACTIVATION_SHARE_OF_REMAINING));
});

test("the mark records what was skipped, which is the whole finding", () => {
  const mark = activationBudgetMark({ budgetMs: 175_000, spentMs: 175_200, allowed: 60, skipped: 40 });
  assert.equal(mark.exhausted, true);
  assert.equal(mark.fields, 100, "the denominator is stated, so nobody has to add two numbers and hope");
  assert.equal(mark.allowed, 60);
  // `allowed`, NOT `activated`: the budget decides what is OFFERED to `operateControl`, and `chooseProbe`
  // then declines most of them. Measured on three captures — 18/46/100 fields offered, 11/26/32 producing
  // an activation record. Calling these activations would overstate by 3x.
  assert.equal(mark.skipped, 40);
});

test("EXHAUSTED means fields were skipped, never merely that time was spent", () => {
  // A page whose every control was activated with the budget fully consumed is NOT exhausted: there was
  // nothing left to skip. Reading `spentMs >= budgetMs` as exhaustion would report a truncation on a page
  // that was examined in full — an invented defect, which is the wrong direction to be wrong in.
  const spentItAll = activationBudgetMark({ budgetMs: 175_000, spentMs: 175_000, allowed: 12, skipped: 0 });
  assert.equal(spentItAll.exhausted, false);
  assert.equal(spentItAll.fields, 12);
});

test("no fields at all is not exhaustion and not examination", () => {
  // THE VACUITY CASE. A page with no form fields produces the same `formChanges: []` as a page whose
  // activation was starved, and the mark is the only thing that can tell them apart. `fields: 0` says
  // there was nothing to ask about; it must never read as either a clean examination or a truncation.
  const nothing = activationBudgetMark({ budgetMs: 175_000, spentMs: 0, allowed: 0, skipped: 0 });
  assert.equal(nothing.exhausted, false);
  assert.equal(nothing.fields, 0);
});
