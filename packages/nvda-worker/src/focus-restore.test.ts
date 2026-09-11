/**
 * #972: RETURN FOCUS TO THE TOP DOCUMENT BEFORE THE SWEEPS -- the remedy #953 measured.
 *
 * #953's half 2 (orchestrator, round 11) held 6 of 6: on every collapsed capture of #951's page, `focusInFrame`
 * named the chat widget's frame, and focus was already there at the reading taken BEFORE the first probe. On
 * every healthy capture it was null. So quick navigation started in the widget, and every sweep type walked it.
 *
 * WHAT A READER OF A CAPTURE FINDS (orchestrator reads these off the fleet's captures):
 *   the `focusRestore` diagnostic mark      every capture: `attempted: false` with `why`, or `attempted: true`
 *                                           with `from` (the frame) and `blurred`
 *   `observed.headings.focusRestored`       only when a restore was attempted: `{ from, left }`, `left` from the
 *                                           first sweep's own `focusInFrame` -- true, false, or null
 *   `observed.<channel>.heldBy`             any sweep that started inside a frame: `complete: false`, naming it
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { focusRestoreDecision, focusRestoredRecord, heldInFrame, sweepObservation } from "./capture-pure.mjs";
import { FOCUS_RESTORE_EXPRESSION } from "./browser-session.mjs";

const source = (file: string) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
const bodyOf = (text: string, signature: string) => {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${signature} must be findable by name`);
  return text.slice(start, text.indexOf("\n}\n", start));
};

test("#972 THE DECISION: focus in an unrequested frame before the sweeps means restore; the top document means no action", () => {
  assert.deepEqual(focusRestoreDecision({ focusFrame: "Chat Widget" }, "sweep"), { restore: true, from: "Chat Widget" });
  const top = focusRestoreDecision({ focusFrame: null }, "sweep");
  assert.equal(top.restore, false);
  assert.match((top as { why: string }).why, /top document/);
});

test("#972: never undo focus a probe of ours may have put there, and never act on a reading that could not say", () => {
  const focusFirst = focusRestoreDecision({ focusFrame: "Chat Widget" }, "focus");
  assert.equal(focusFirst.restore, false, "under probeOrder focus-first the Tab walk runs first -- a named limit");
  assert.match((focusFirst as { why: string }).why, /probe runs before the sweeps/);
  for (const state of [null, {}, { focusFrame: { cannotSay: "a closed root" } }]) {
    assert.equal(focusRestoreDecision(state as never, "sweep").restore, false, `${JSON.stringify(state)} is not evidence of a frame`);
  }
});

test("#972 THE RECORD: `left` comes from the first sweep's own census -- true, false, or null when it could not say", () => {
  assert.deepEqual(focusRestoredRecord("Chat Widget", { focusInFrame: null }), { from: "Chat Widget", left: true });
  assert.deepEqual(focusRestoredRecord("Chat Widget", { focusInFrame: "Chat Widget" }), { from: "Chat Widget", left: false });
  assert.deepEqual(focusRestoredRecord("Chat Widget", {}), { from: "Chat Widget", left: null });
  assert.deepEqual(focusRestoredRecord("Chat Widget", undefined), { from: "Chat Widget", left: null });
});

test("#972 THE BACKSTOP: a sweep that started inside a frame is incomplete and names what held it; NVDA's stops are kept", () => {
  const exhausted = sweepObservation({ stop: "exhausted" }, { stop: "exhausted" });
  const held = heldInFrame({ ...exhausted, focusInFrame: "Chat Widget" }, { focusInFrame: "Chat Widget" });
  assert.equal(held.complete, false, "never recorded as the page's evidence");
  assert.equal((held as { heldBy?: string }).heldBy, "Chat Widget");
  assert.deepEqual(held.stop, { prev: "exhausted", next: "exhausted" }, "the directions really did exhaust, inside the frame");
  assert.deepEqual(heldInFrame(exhausted, { focusInFrame: null }), exhausted, "a sweep that started in the page is untouched");
  assert.deepEqual(heldInFrame(exhausted, {}), exhausted, "and so is one whose start could not be read");
});

test("#972 THE PAGE SIDE: blur the focused frame and focus the window -- adding nothing to the page", () => {
  const calls: string[] = [];
  const frame = { tagName: "IFRAME", blur: () => calls.push("blur") };
  const window = { focus: () => calls.push("window.focus") };
  const out = new Function("document", "window", `return ${FOCUS_RESTORE_EXPRESSION}`)({ activeElement: frame }, window);
  assert.deepEqual(out, { blurred: true });
  assert.deepEqual(calls, ["blur", "window.focus"]);
  assert.doesNotMatch(FOCUS_RESTORE_EXPRESSION, /setAttribute|tabindex|createElement|appendChild/i,
    "a restore that edited the DOM would change the evidence it exists to rescue");
  const nothing = new Function("document", "window", `return ${FOCUS_RESTORE_EXPRESSION}`)({ activeElement: null }, { focus: () => {} });
  assert.deepEqual(nothing, { blurred: false });
});

test("#972 WIRED: once, before the FIRST probe, from the reading #953 measured; marked every time; recorded on the first sweep", () => {
  const probes = source("capture-probes.mjs");
  const sequence = bodyOf(probes, "async function runProbeSequence(");
  assert.match(sequence, /const state = await markPageState\(step, diag\);\n[\s\S]*if \(i === 0\) restoredFrom = await restoreFocusBeforeSweeps\(state, step, diag\);/,
    "the restore is decided from the pre-probe reading, before the first step only");
  assert.match(sequence, /observed\.headings = \{ \.\.\.observed\.headings, focusRestored: focusRestoredRecord\(restoredFrom, observed\.headings\) \}/);
  const restore = bodyOf(probes, "async function restoreFocusBeforeSweeps(");
  assert.match(restore, /await restoreTopDocumentFocus\(\);/, "a restore decision is acted on");
  assert.equal((restore.match(/diag\.mark\("focusRestore"/g) ?? []).length, 2, "marked on both branches -- 'not needed' is never silence");
  assert.match(bodyOf(probes, "async function collectByType("), /heldInFrame\(ctx\.observed\[ctx\.observedAs \?\? ctx\.label\], focusInFrameOf\(scopeAt\)\)/,
    "every sweep's record carries the backstop");
  assert.match(probes, /await runProbeSequence\(\{ probeOrder, diag, runSweep, runFocus, observed \}\);/);
});
