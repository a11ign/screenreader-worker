/**
 * `probeFocusOrder` and `probeFocusContext` both Tab-walk relative to whatever DOM focus an earlier probe
 * left behind — the same exposure `§43` fixed in `probeFocusReveal`, found by `docs/probe-side-effects.md`'s
 * audit. `anchorToTop` (which both already called) resets NVDA's caret and mode and never DOM focus, so
 * without this fix each probe's first Tab moves relative to whatever the sweep's own disclosure activation
 * (unconditional, not gated on an opt-in flag) left focused — and `probeFocusOrder` is the channel 2.1.1,
 * 2.1.2, 2.4.1 and 2.4.3 all read.
 *
 * Neither probe can be driven without real NVDA — `capture-core.mjs` imports guidepup, which throws at
 * module load with no screen reader present (see `pure-graph.test.ts`) — so nothing here can import and
 * call them. This is the SAME documented exception `focus-reveal.test.ts`'s own sequencing test already
 * uses for the identical reason: read the source and assert the call is where it has to be, never merely
 * present somewhere in the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "./capture-probes.mjs"), "utf8");

/** The body of one `async function <name>(...) {...}`, up to the next top-level function declaration. */
function functionBody(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in capture-probes.mjs -- this test examines nothing until it is`);
  const rest = SOURCE.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  return rest.slice(0, nextFn >= 0 ? nextFn : rest.length);
}

test("probeFocusOrder resets DOM focus before its Tab walk, not just its own caret", () => {
  const body = functionBody("probeFocusOrder");
  const resetAt = body.indexOf("resetFocusToDocumentStart()");
  const loopAt = body.indexOf("for (let i = 0; i < MAX_TAB_STOPS");
  assert.ok(resetAt >= 0,
    "probeFocusOrder must call resetFocusToDocumentStart -- the §43 fix, applied to the channel " +
    "2.1.1/2.1.2/2.4.1/2.4.3 all read");
  assert.ok(loopAt >= 0, "the Tab-walk loop marker moved -- update this test to find the walk, not to pass");
  assert.ok(resetAt < loopAt,
    "the reset must run BEFORE the walk begins, or it cannot protect the walk's first stop");
});

test("probeFocusContext resets DOM focus before its Tab walk, not just its own caret", () => {
  const body = functionBody("probeFocusContext");
  const resetAt = body.indexOf("resetFocusToDocumentStart()");
  const loopAt = body.indexOf("for (; stops < FOCUS_CONTEXT_STOPS");
  assert.ok(resetAt >= 0, "probeFocusContext must call resetFocusToDocumentStart -- the same §43 fix");
  assert.ok(loopAt >= 0, "the Tab-walk loop marker moved -- update this test to find the walk, not to pass");
  assert.ok(resetAt < loopAt,
    "the reset must run BEFORE the walk begins, or it cannot protect the walk's first stop");
});

test("both probes record startedFrom and focusReset on their own mark, not just call the reset blindly", () => {
  // A reset that runs but is never recorded is the same silence this repo has already paid for once:
  // "did not need to" and "never ran" must stay distinguishable, and that needs the mark to carry both
  // fields -- not just the call to exist somewhere in the function body.
  for (const name of ["probeFocusOrder", "probeFocusContext"]) {
    const body = functionBody(name);
    assert.match(body, /startedFrom/, `${name} must record where the walk started, on its diagnostic mark`);
    assert.match(body, /focusReset/, `${name} must record whether the reset applied, on its diagnostic mark`);
  }
});
