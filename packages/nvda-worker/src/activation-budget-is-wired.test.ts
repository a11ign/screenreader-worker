/**
 * THE BUDGET IS ONLY A BUDGET IF EVERY ACTIVATION GOES THROUGH IT — #677 part 2.
 *
 * `activationBudgetFor` decides whether a form field is offered to `operateControl`. A second call site
 * reaching `operateControl` directly would not fail anything: the capture would still work, the mark
 * would still be written, and the budget would silently apply to some activations and not others. That is
 * this repository's most expensive recurring shape — a remedy applied at ONE call site when the behaviour
 * reaches several — and it has no runtime symptom, so a guard is the only thing that can see it.
 *
 * READ FROM THE SOURCE, which this repo normally forbids for expectations. The exemption is
 * `activation-gates.test.ts`'s and narrow, for the same reason: `capture-probes.mjs` imports guidepup and
 * throws at module load where no screen reader exists, so no test can call these functions. The
 * alternative is no guard at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8");
const LINES = SOURCE.split("\n");

/** A CALL, not the declaration. `async function operateControl(` must not count as a call site. */
const callsOperateControl = (line: string) =>
  /(^|[^\w.])operateControl\s*\(/.test(line) && !/function\s+operateControl\s*\(/.test(line);

test("operateControl has exactly ONE call site, and it is inside the budget", () => {
  const sites = LINES
    .map((line, i) => ({ line: line.trim(), number: i + 1 }))
    .filter(({ line }) => callsOperateControl(line));

  assert.equal(sites.length, 1,
    `operateControl is called from ${sites.length} place(s): `
    + `${sites.map((s) => `capture-probes.mjs:${s.number}`).join(", ")}. A call outside `
    + "`activationBudgetFor` activates a control the budget never counted and never refused, so the "
    + "budget becomes advisory with no symptom — #677 part 2.");

  // INSIDE the budget, not merely once. A single call site in the wrong function is the same defect.
  const inBudget = SOURCE.slice(SOURCE.indexOf("function activationBudgetFor"));
  assert.ok(callsOperateControl(inBudget.slice(0, inBudget.indexOf("\n}\n"))
    .split("\n").find(callsOperateControl) ?? ""),
    "the one call site is not inside `activationBudgetFor`");
});

test("the budget is sized when the sweep begins, not when the closure is built", () => {
  // `activationDeadline` takes a SHARE of what remains. Called where the closure is constructed, that
  // share would include the time the heading and landmark sweeps are about to spend — so the activation
  // would be handed a budget out of somebody else's phase. The lazy computation is what makes the
  // function's own contract ("what is left when its sweep begins") true.
  const budget = SOURCE.slice(SOURCE.indexOf("function activationBudgetFor"));
  const call = budget.indexOf("activationDeadline(deadline)");
  const guard = budget.indexOf("stopsAt === null");
  assert.ok(guard !== -1 && call !== -1 && guard < call,
    "`activationDeadline` must be called behind the `stopsAt === null` first-field guard");
});

test("a skipped field is COUNTED, never silently dropped", () => {
  // The whole finding is that "every control was offered and none announced anything" and "we ran out of
  // time and stopped asking" are the same `formChanges: []`. A `return` on the budget path that did not
  // increment `skipped` would restore exactly that conflation.
  const budget = SOURCE.slice(SOURCE.indexOf("function activationBudgetFor"));
  const overBudget = budget.slice(budget.indexOf("Date.now() > stopsAt"));
  assert.match(overBudget.slice(0, 200), /skipped \+= 1/,
    "the over-budget branch must increment `skipped` before returning");
});

test("the mark is emitted BY the budget, and skipped when none was consulted", () => {
  const budget = SOURCE.slice(SOURCE.indexOf("function activationBudgetFor"));
  assert.match(budget, /diag\.mark\("activationBudget"/,
    "nothing writes the activationBudget mark, so the capture records no budget at all");
  // The early return is a THIRD state and must not be marked as a spent budget of zero: a configured form
  // activates exactly the control the author named and keeps no budget, and a page with no form controls
  // offered none. `fields: 0` for either would claim a budget covered everything it was asked about.
  const markFn = budget.slice(budget.indexOf("markInto:"));
  assert.ok(markFn.indexOf("stopsAt === null) return") < markFn.indexOf("diag.mark"),
    "the null case must return BEFORE marking — absent and 'zero fields' are different facts");
  assert.match(SOURCE, /activation\.markInto\(diag\)/, "the caller never invokes the budget's mark");
});

test("the timing is charged in a finally, so a throwing probe still pays", () => {
  // A failing activation costs the same wall clock as a working one. Charging only the success path would
  // let a page of broken controls spend the whole capture while the mark reported an untouched budget —
  // an accounting that is wrong in the direction that hides the problem it exists to show.
  const budget = SOURCE.slice(SOURCE.indexOf("function activationBudgetFor"));
  assert.match(budget, /\.finally\(\(\) => \{ spentMs \+= Date\.now\(\) - at; \}\)/,
    "elapsed time must be charged in a `finally`, not after an awaited success");
});
