/**
 * EVERY PROBE THAT CAN LEAVE NVDA IN FOCUS MODE MUST GIVE THE MODE BACK, AND IN A `finally`.
 *
 * In focus mode a quick-navigation letter is not a command, it is INPUT — the sweep types `hhkkllgg` into
 * the page it is measuring. That is the 353-capture contamination `operateControl`'s own comment documents
 * at length, and `restoreBrowseMode` is this file's proven route out (`refreshBrowseBuffer` then
 * `anchorToTop`, both halves needed — see that function's comment for what each one cost to learn).
 *
 * `probeDialogEscape` was the only one of the five focus-riding probes with no restore at all, found by
 * `docs/probe-side-effects.md`'s audit. It was absorbed by whichever probe ran next calling `anchorToTop`
 * itself — but those are opt-in, so the protection was a property of which flags happened to be set.
 *
 * IN A `finally`, not on the happy path: a probe that borrowed focus mode and THREW still owes it back, and
 * the throw is exactly when the mode is most likely wrong. Four of the five already do this; asserting the
 * placement rather than mere presence is what stops a future edit satisfying the letter of it.
 *
 * SOURCE TEXT, with the anti-vacuity guards that requires — `capture-core.mjs` imports guidepup, which
 * throws at module load with no screen reader, so none of these probes can be imported and called
 * (`pure-graph.test.ts` records this). Markers are CALL SYNTAX, never bare names: this file's prose names
 * `restoreBrowseMode` in several comments, and a previous unit shipped a test whose bare `indexOf` stayed
 * non-negative after the call was mutated away for exactly that reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "./capture-probes.mjs"), "utf8");

/** Every probe that deliberately enters, or can be left in, focus mode — and so owes the mode back. */
const FOCUS_RIDING_PROBES = [
  "probeFocusContext",
  "probeFocusReveal",
  "probeDialogEscape",
  "probeArrowNavigation",
  "probeTypedFeedback",
];

function functionBody(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in capture-probes.mjs -- this test examines nothing until it is`);
  const rest = SOURCE.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  return rest.slice(0, nextFn >= 0 ? nextFn : rest.length);
}

test("every focus-riding probe restores browse mode, by call and not by comment", () => {
  for (const name of FOCUS_RIDING_PROBES) {
    const body = functionBody(name);
    assert.match(body, /restoreBrowseMode\(/,
      `${name} must CALL restoreBrowseMode. In focus mode a quick-nav letter is typed into the page under `
      + "test, which is the 353-capture contamination this file documents -- and a probe that does not give "
      + "the mode back is relying on whatever runs next to do it, which is opt-in and therefore not a guarantee");
  }
});

test("the restore is in a finally, so a probe that THREW still gives the mode back", () => {
  for (const name of FOCUS_RIDING_PROBES) {
    const body = functionBody(name);
    const finallyAt = body.indexOf("} finally {");
    const restoreAt = body.indexOf("restoreBrowseMode(");
    assert.ok(finallyAt >= 0, `${name} has no finally block -- its restore cannot survive a throw`);
    assert.ok(restoreAt > finallyAt,
      `${name} restores browse mode outside its finally. A probe that borrowed focus mode and threw still `
      + "owes it back, and the throw path is when the mode is most likely wrong");
  }
});
