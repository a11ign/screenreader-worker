/**
 * What is this tool allowed to PRESS?
 *
 * `probe-forms` defaults ON in the GitHub Action, because reviewing a page means checking what is on it
 * and an error message nobody hears is only reachable by submitting. That makes this decision the safety
 * gate for a tool that now operates controls on a live application by default, so it needs a test that
 * runs anywhere — not a 4-minute Windows job, and not a Windows VM.
 *
 * It could not have one before. The decision lived in `capture-core.mjs`, which imports guidepup, which
 * throws at module load where no screen reader exists; `pure-graph.test.ts` exists to enforce that no test
 * reaches that file. So the policy moved to `capture-pure.mjs` and the dispatch stayed behind.
 *
 * The CLI keeps `probe-forms` OFF, and the asymmetry is the point: a workflow tests your own application,
 * while the CLI can be aimed at any URL on the internet. Both defaults are exercised below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeKindFor } from "./capture-pure.mjs";

const CLI = { probeForms: false, task: "Book a room for two nights" };
const ACTION = { probeForms: true, task: "Book a room for two nights" };

test("a disclosure is activated even with probing OFF, because expanding is side-effect-free", () => {
  // The unconditional case, and it is deliberate: whether the expanded state is announced at all is
  // 4.1.2, and toggling visibility cannot submit, send, buy or delete anything.
  assert.equal(probeKindFor("Travel advice, button, collapsed", CLI), "disclosure");
  assert.equal(probeKindFor("Travel advice, button, collapsed", ACTION), "disclosure");
});

test("with probing OFF nothing state-changing is touched, however submit-like the name", () => {
  // The CLI default. Pointed at a stranger's production site, this tool must not press *Book* — so the
  // guard is asserted on the exact names that would do real damage.
  for (const phrase of [
    "Book now, button", "Send message, button", "Subscribe, button",
    "Sign in, button", "Save changes, button", "Reserve table, button",
  ]) {
    assert.equal(probeKindFor(phrase, CLI), null, `${phrase} must not be activated with probing off`);
  }
});

test("with probing ON a submit-like button is activated, because 3.3.1 is otherwise unreachable", () => {
  // The Action default. An unannounced validation error only exists after a submit, so refusing to submit
  // does not make the page clean — it makes the criterion unmeasurable, which is the distinction this
  // project refuses to blur anywhere else.
  assert.equal(probeKindFor("Submit request, button", ACTION), "submit");
  assert.equal(probeKindFor("Sign in, button", ACTION), "submit");
});

test("a button the task NAMES is activated; an unrelated one is not", () => {
  // The word match is the guard that makes task-driven activation safe. "Book a room" reaches a *Rooms*
  // button and must never reach *Delete account*.
  assert.equal(probeKindFor("Rooms, button", { probeForms: true, task: "Show me the rooms" }), "task");
  assert.equal(probeKindFor("Delete account, button", { probeForms: true, task: "Show me the rooms" }), null);
});

test("a task made only of role and state words matches nothing", () => {
  // Without excluding role words, a task containing "button" would match EVERY button on the page, which
  // turns the guard into a pass-through while still looking like a guard.
  assert.equal(probeKindFor("Delete account, button", { probeForms: true, task: "click the button" }), null);
  assert.equal(probeKindFor("Delete account, button", { probeForms: true, task: "expand the menu item" }), null);
});

test("a LINK is never activated, whatever it is called", () => {
  // Activating a link navigates away, which ends the capture of the page under test.
  assert.equal(probeKindFor("Sign in, link", ACTION), null);
  assert.equal(probeKindFor("Book now, link", ACTION), null);
});

test("no task means no task-driven activation, rather than matching everything", () => {
  assert.equal(probeKindFor("Rooms, button", { probeForms: true }), null);
  assert.equal(probeKindFor("Rooms, button", { probeForms: true, task: "" }), null);
});

test("a missing or malformed phrase is not a crash", () => {
  // This runs per announced control on every capture; a throw here would fail the capture and be recorded
  // as the page announcing nothing, which is a real finding's signature.
  assert.equal(probeKindFor(undefined as never, ACTION), null);
  assert.equal(probeKindFor("", ACTION), null);
});

test("a checkbox and a radio button are operated under probeForms, and not without it", () => {
  // 4.1.3 asks whether a status message is announced, and a live region updated by a CHECKBOX was
  // structurally unreachable — real filters, consent toggles and "show prices including VAT" controls are
  // checkboxes far more often than buttons. Decided in SECURITY.md: the line is not how destructive a
  // control might be, it is whether activating it can NAVIGATE.
  assert.equal(probeKindFor("Show prices including VAT, check box, not checked", { probeForms: true }), "toggle");
  assert.equal(probeKindFor("Standard delivery, radio button, not checked", { probeForms: true }), "toggle");
  // And nothing happens where the operator has not said they own the page. `probeForms` is off in the CLI,
  // which is what makes this a widening INSIDE an existing consent rather than the granting of one.
  assert.equal(probeKindFor("Show prices including VAT, check box, not checked", { probeForms: false }), null);
});

test("no task word is required for a toggle, deliberately", () => {
  // Requiring one would reproduce the gap this closes: a filter checkbox is named for the thing it
  // filters, never for the task. The consent a BUTTON's name carries is doing different work — activating
  // a button is its whole purpose, so the name is the only thing between a probe and *Delete account*.
  assert.equal(probeKindFor("Include VAT, check box, not checked", { probeForms: true, task: "book a room" }),
    "toggle");
  // The button rule is untouched by that, and this is the assertion that proves it.
  assert.equal(probeKindFor("Delete account, button", { probeForms: true, task: "book a room" }), null);
});

test("a radio is classified as a toggle, not fumbled into the button rules", () => {
  // NVDA announces a radio as "radio button", so `\bbutton\b` matches it. Whichever pattern reads it first
  // decides what it is: tested before the button test, it is a toggle; after, it falls through to the
  // submit/task rules and is silently rejected for having no task word. That is this repo's "one element
  // announced with TWO roles" defect, and the fix is an ORDER rather than a cleverer pattern.
  //
  // Mutation-checked: moving TOGGLE_RE below the button test makes this the assertion that fails.
  assert.equal(probeKindFor("Standard delivery, radio button", { probeForms: true, task: "unrelated" }),
    "toggle");
});

test("a combo box is still caught by the DISCLOSURE rule, ungated — a fact, not an endorsement", () => {
  // Pinned because writing SECURITY.md is what found it: a `<select>` announces as "combo box, collapsed",
  // so rule 1 has always activated it WITHOUT `probeForms`. The first draft of that document asserted the
  // opposite, and running this function refuted it in one line.
  //
  // The exposure is smaller than it looks and the reason is checkable: the disclosure probe presses Enter,
  // and Enter does not change a select's value — arrow keys do, and the jump-menu idiom fires on `change`.
  // Asserted here so a future change to the disclosure rule cannot alter it silently.
  assert.equal(probeKindFor("Sort by, combo box, collapsed", { probeForms: false }), "disclosure");
});
