// The pointer is a capture input, not a bystander: it holds hover state over whatever it rests on, so
// where it sits decides what the page renders and therefore what NVDA reads.
//
// `parkPointer` itself shells out to PowerShell and can only run on the guest. The decision it makes
// first — where to put the pointer — is pure, and it is the part that can be wrong silently: a bad
// override that produced NaN coordinates would either throw inside the capture or move the pointer
// somewhere unpredictable, and both look like a flaky guest rather than a typo.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parkPointForTest as parkPoint, parkPointer } from "./pointer.mjs";

/** The override is read per call, so each case sets and clears it rather than relying on order. */
function withOverride<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.A11Y_POINTER_AT;
  if (value === undefined) delete process.env.A11Y_POINTER_AT;
  else process.env.A11Y_POINTER_AT = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.A11Y_POINTER_AT;
    else process.env.A11Y_POINTER_AT = previous;
  }
}

test("with no override the pointer parks off the page, at the top-left", () => {
  // Captures run --app, so the top-left pixel is the title bar when maximized and bare desktop when
  // not. Either way it is not page content, which is the only property that matters.
  assert.deepEqual(withOverride(undefined, parkPoint), { x: 0, y: 0 });
});

test("the override aims the pointer, because reproducing the fault needs it ON an image", () => {
  // This lever is why the Magnify fix could be attributed rather than assumed: gov.uk's hero image
  // under the pointer reproduces "Image Magnify, document" on demand.
  assert.deepEqual(withOverride("640, 420", parkPoint), { x: 640, y: 420 });
});

test("a malformed override falls back to the safe point instead of NaN", () => {
  // A half-written override ("640") or a stray unit ("640px,420") must not reach SetCursorPos. NaN
  // coordinates would surface as an unexplained capture failure on one guest, which is precisely the
  // kind of fault this project has spent days misattributing to the VM.
  for (const bad of ["640", "", "x,y", "640px,420", ",", "640,"]) {
    assert.deepEqual(withOverride(bad, parkPoint), { x: 0, y: 0 }, `"${bad}" must not park the pointer`);
  }
});

test("parkPointer retries once, and says which attempt succeeded", async () => {
  // "Parked first time" and "parked on the retry" must not be the same silence — a rising retry rate is
  // the signal that the transient spawn failure is becoming something else, and a bare `pointerParked`
  // mark cannot carry it. Same rule as `refreshBrowseBuffer` marking when it SKIPS.
  const marks: { event: string; detail: Record<string, unknown> }[] = [];
  const diag = { mark: (event: string, detail: object) => marks.push({ event, detail: detail as Record<string, unknown> }) };
  let calls = 0;
  await parkPointer(diag, {
    setCursor: async () => { calls += 1; if (calls === 1) throw new Error("Command failed: powershell"); },
  });
  assert.equal(calls, 2, "a first failure must be retried");
  assert.deepEqual(marks.map((m) => m.event), ["pointerParked"]);
  assert.equal(marks[0].detail.attempts, 2, "the mark must say it took two attempts");
});

test("parkPointer gives up after two attempts and never throws", async () => {
  // A guest that cannot move its own pointer still produces a capture, carrying whatever hover state it
  // had — which is what every capture carried before the park existed. Turning that into a failed capture
  // trades a quiet risk for a loud outage. The audit names the pairs it split instead.
  const marks: { event: string; detail: Record<string, unknown> }[] = [];
  const diag = { mark: (event: string, detail: object) => marks.push({ event, detail: detail as Record<string, unknown> }) };
  let calls = 0;
  await parkPointer(diag, {
    setCursor: async () => { calls += 1; throw new Error("Command failed: powershell"); },
  });
  assert.equal(calls, 2, "exactly two attempts — a third would be a poll disguised as a remedy");
  assert.deepEqual(marks.map((m) => m.event), ["pointerParkFailed"]);
  assert.equal(marks[0].detail.attempts, 2);
});
