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
