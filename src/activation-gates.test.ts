/**
 * NOTHING IN THE CAPTURE PATH MAY GATE POST-ACTIVATION EVIDENCE ON `probeForms`.
 *
 * `probeForms` answers "is the OPPORTUNISTIC probe on". It does not answer "was a control activated",
 * because a declared `formState` activates one while `probeForms` stays false — deliberately, since a
 * config is the page owner's own example and `probeForms` pressing things on a stranger's site is not
 * (SECURITY.md, ADR 0024).
 *
 * **The same confusion was found at TWO call sites on 2026-09-03, an hour apart**, which is this repo's
 * most expensive recurring shape — a remedy applied where the behaviour reaches several places:
 *
 * - `recordWhatWasAsked` recorded *"probeForms is off, so no control was activated"* about a control it
 *   had activated, marking the only real-site 3.3.1/4.1.3 evidence as never looked for.
 * - `rescanFormFieldsAfterSubmit` simply did not run, so `postSubmitFields` was `[]` on every configured
 *   capture — and `build-realism` masks 4.1.3 on exactly `postSubmitFields.length > 0`, so the capture
 *   run the backlog prescribes to move `4.1.3: 0 of 37` would have moved nothing.
 *
 * Neither is visible to `tsc` or ESLint: this is `.mjs` reading a duck-typed context, and both gates were
 * syntactically fine. So the guard reads the SOURCE for the shape, which this repo normally forbids for
 * expectations — the exemption is deliberate and narrow. This package imports guidepup and throws at
 * module load where no screen reader exists, so no test can call these functions; the alternative is no
 * guard at all, and the two misses cost a corpus row each.
 *
 * Reads `capture-probes.mjs`, not `capture-core.mjs`: both call sites this guards
 * (`rescanFormFieldsAfterSubmit`, `probeConfiguredForm`) live there since the 2026-09-05 split.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CORE = readFileSync(
  resolve(import.meta.dirname, "capture-probes.mjs"), "utf8").split("\n");

/**
 * Evidence that only exists AFTER something was operated. A gate on `probeForms` in the same expression
 * as one of these is the defect; a gate on `formChanges.length` is the correct form, because an entry
 * there is the record that an activation happened, whichever probe did it.
 */
const POST_ACTIVATION = ["postSubmitFields", "formChanges", "postSubmitNames"];

test("no post-activation evidence is gated on `probeForms`", () => {
  const offenders = CORE
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    // A CONDITION, not a mention. `probeForms` is passed as an argument and reported in a diagnostic in
    // several correct places; only a branch that decides whether evidence is COLLECTED is the fault.
    .filter(({ line }) => /^(if|\}? ?else if)\s*\(/.test(line) || /\?\s*$/.test(line))
    .filter(({ line }) => /\bprobeForms\b/.test(line))
    .filter(({ line }) => POST_ACTIVATION.some((field) => line.includes(field)))
    // A DIAGNOSTIC MARK IS NOT EVIDENCE COLLECTION, and the first version of this flagged one:
    // `if (probeForms) diag.mark("formProbe", { activated: ... })`. That line is correct — it records
    // what the OPPORTUNISTIC probe did, and the configured path writes its own `configuredForm` mark, so
    // neither is silent about itself. Excluded narrowly, by what the branch DOES rather than by line
    // number, and the test below pins the configured path's mark so this exclusion cannot hide a gap.
    .filter(({ line }) => !/\bdiag\.mark\(/.test(line));

  assert.deepEqual(offenders.map((o) => `capture-probes.mjs:${o.number}  ${o.line}`), [],
    "A branch gates post-activation evidence on `probeForms`. That flag says whether the OPPORTUNISTIC\n"
    + "probe is on; it does not say whether a control was activated, because a declared `formState`\n"
    + "activates one with `probeForms` false. Gate on `interaction.formChanges.length > 0` instead — an\n"
    + "entry there is the record that something was operated, whichever probe did it.");
});

test("the matcher can see the shape it forbids, or it guards nothing", () => {
  // A guard must be shown to fail before it is trusted, and this one reads source text — the exact kind
  // that has passed while examining nothing in this repo (a `sweepLog` guard, a signal-type regex).
  const planted = [
    "  if (probeForms && interaction.formChanges.length > 0) {",
    "  results.postSubmitFields = probeForms ?",
  ];
  for (const line of planted) {
    const matchesCondition = /^(if|\}? ?else if)\s*\(/.test(line.trim()) || /\?\s*$/.test(line.trim());
    assert.ok(matchesCondition && /\bprobeForms\b/.test(line)
      && POST_ACTIVATION.some((field) => line.includes(field)),
      `the matcher would not flag: ${line.trim()}`);
  }
});

test("the correct form is NOT flagged, or the guard refuses the fix it asks for", () => {
  const good = "  if (interaction.formChanges.length > 0) {";
  assert.ok(!/\bprobeForms\b/.test(good), "the remedy this guard names must pass it");
});


test("the configured path marks itself, so an absent `formProbe` is not silence", () => {
  // The exclusion above is only safe because this holds. `formProbe` is written under `probeForms`, so a
  // configured capture carries none — and "the opportunistic probe did not run" must not be readable as
  // "no form was operated". `probeConfiguredForm` marks `configuredForm` on every path it can take,
  // including the two ways it can decline: no field matched, and the named submit was not found.
  const text = CORE.join("\n");
  assert.ok(text.includes('diag.mark("configuredForm"'),
    "the configured form writes no diagnostic mark, so a capture that ran it is indistinguishable from "
    + "one that did not — the `refreshBrowseBuffer` defect, which passed three green runs while inert");
  const marks = (text.match(/diag\.mark\("configuredForm"/g) ?? []).length;
  assert.ok(marks >= 3,
    `only ${marks} \`configuredForm\` mark(s): the probe has a submitted path and two declining paths `
    + "(no field matched, submit not found), and each must be able to say which it took");
});
