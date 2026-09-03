/**
 * A CONFIGURED FORM IS AN ACTIVATION, and `recordWhatWasAsked` did not know it.
 *
 * `capture-real-pages` sends `probeForms: false` together with a `formState`, and that posture is
 * deliberate: the opportunistic probe presses whatever submit-like control the sweep walks past, on a page
 * we do not own, while a `formState` is the page owner's own example recorded in the corpus (ADR 0024).
 * But `probeForms` was the only thing this function consulted, so every configured capture recorded
 * *"probeForms is off for this capture, so no control was activated"* about a control it HAD activated.
 *
 * **That is not a cosmetic wrong `why`.** `observed` is what the featurizer crosses `formChanges` and
 * `postSubmitFields` against, and `asked: false` is the "never asked" row — so the real-page captures
 * carrying the only 3.3.1 and 4.1.3 evidence from a real site would have been marked as never having
 * looked for it. The field that exists to separate "the page has none" from "we could not ask" said the
 * second about the one capture that did ask.
 *
 * **There was no guard, and a comment said there was.** The call site named `observation-parity.test.ts`,
 * which tests the corpus-side and rules-side predicates for arrows and Escape and nothing about these
 * flags. A comment naming a guard that guards something else is worse than no comment: it stops the next
 * reader looking. The function moved into `capture-pure.mjs` so a test can reach it at all — `capture-core`
 * imports guidepup, which throws at module load where no screen reader exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { recordWhatWasAsked } from "./capture-pure.mjs";

const FORM_STATE = {
  state: "error",
  submit: "submit",
  fields: [{ field: "e Mail Address:", value: "ada@example.test" }],
};

function ask(overrides: Record<string, unknown> = {}) {
  const observed: Record<string, { asked: boolean; why?: string; activated?: number; configured?: boolean }> = {};
  recordWhatWasAsked({
    observed,
    probeForms: false,
    probeFocus: true,
    probeNavigation: false,
    probeDialog: false,
    probeArrows: false,
    probeTyping: false,
    probeFocusContext: false,
    interaction: { formChanges: [] },
    ...overrides,
  });
  return observed;
}

const SUBMITTED = { formChanges: [{ kind: "submit", control: "Submit, button", after: "Submission Failed" }] };

test("a configured form counts as an activation, with probeForms off", () => {
  const observed = ask({ formState: FORM_STATE, interaction: SUBMITTED });
  assert.equal(observed.formChanges.asked, true,
    "a formState activated a control; recording `asked: false` puts real evidence in the 'never asked' row");
  assert.equal(observed.postSubmitFields.asked, true,
    "the form was submitted and re-read — this is the channel 3.3.1 and 4.1.3 are decided from");
});

test("it says WHICH probe asked, so a reader need not infer it from the flags", () => {
  // `probeForms` is false on every configured capture, so the flags alone cannot answer "did somebody
  // press something, and who". Reported rather than derivable is the point.
  const configured = ask({ formState: FORM_STATE, interaction: SUBMITTED });
  assert.equal(configured.formChanges.configured, true);
  const opportunistic = ask({ probeForms: true, interaction: SUBMITTED });
  assert.equal(opportunistic.formChanges.configured, false);
});

test("no probe and no config is still not-asked, and says both", () => {
  const observed = ask();
  assert.equal(observed.formChanges.asked, false);
  assert.match(String(observed.formChanges.why), /probeForms is off and no formState was configured/,
    "the reason must name BOTH routes, or a reader concludes turning probeForms on is the only fix");
});

test("a configured form that activated NOTHING is not the same as one that was never configured", () => {
  // The distinction this whole field exists for, one level in. A `formState` whose fields matched nothing
  // -- which is what `before/survey.html` does, because its controls have no accessible names -- must not
  // read the same as a capture nobody configured. The first is a finding about the PAGE (4.1.2, ADR 0024's
  // central claim); the second is a fact about the request.
  const configuredButInert = ask({ formState: FORM_STATE, interaction: { formChanges: [] } });
  assert.equal(configuredButInert.postSubmitFields.asked, false);
  assert.match(String(configuredButInert.postSubmitFields.why),
    /a formState was configured but activated nothing/);

  const neverConfigured = ask();
  assert.notEqual(configuredButInert.postSubmitFields.why, neverConfigured.postSubmitFields.why,
    "these two must not report the same reason — they need opposite responses");
});

test("the focus-dependent probes still behave exactly as they did", () => {
  // The move to `capture-pure.mjs` must change nothing else. `probeDialog` without `probeFocus` is the
  // case whose `why` was added because a bare `false` sent a reader to the wrong question.
  const withoutFocus = ask({ probeDialog: true, probeFocus: false });
  assert.equal(withoutFocus.dialogEscape.asked, false);
  assert.match(String(withoutFocus.dialogEscape.why), /WITHOUT probeFocus/);

  const withFocus = ask({ probeDialog: true, probeFocus: true });
  assert.equal(withFocus.dialogEscape.asked, true);
});
