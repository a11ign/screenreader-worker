// The worker's own retry decision, and — the part that actually matters — that it still recognises
// the fault capture-core really throws.
//
// The first version of these tests asserted against a copy of the error MESSAGE. That is a test that
// cannot discriminate: reword the message in capture-core and recovery stops working in production
// while this file keeps passing, because the string it checks lives here rather than there. The fix is
// twofold — capture-core tags faults with codes (capture-faults.mjs), and the test below drives the
// real gate instead of a paraphrase of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocallyRecoverable } from "./worker-recovery.mjs";
import { captureFault, FAULT } from "./capture-faults.mjs";
import { failIfScreenReaderIsMute } from "./capture-pure.mjs";

/** The shape capture-core's diagnostics have, with only what this gate reads. */
const diagnostics = (lastSpoken: string | undefined) => ({
  entries: lastSpoken === undefined ? [] : [{ event: "afterStart", lastSpoken }],
  mark() { /* the gate records a mark before throwing; nothing here needs to observe it */ },
});

test("the real gate throws a fault the worker recognises as recoverable", () => {
  // The coupling under test: capture-core throws -> worker-recovery retries. If either side drifts,
  // this fails, which is the whole point.
  const diag = diagnostics("");
  assert.throws(
    () => failIfScreenReaderIsMute(["heading, level 1, Museum 004 controls"], diag),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, FAULT.SCREEN_READER_MUTE);
      assert.equal(isLocallyRecoverable(error), true, "the worker must retry the fault capture-core throws");
      return true;
    });
});

test("a read-through that heard more than one phrase is not a mute", () => {
  const diag = diagnostics("");
  assert.doesNotThrow(() => failIfScreenReaderIsMute(["first line", "second line"], diag));
});

test("NVDA speaking at startup is never a mute, however short the transcript", () => {
  // Both signals are required. A one-phrase page whose screen reader DID speak is a different fault,
  // and treating it as a mute would restart NVDA for no reason.
  const diag = diagnostics("Museum 004 controls");
  assert.doesNotThrow(() => failIfScreenReaderIsMute(["only line"], diag));
});

test("a missing startup diagnostic is not treated as a mute", () => {
  assert.doesNotThrow(() => failIfScreenReaderIsMute(["only line"], diagnostics(undefined)));
});

test("a failed screen-reader start is recoverable — the guest is still settling", () => {
  assert.equal(isLocallyRecoverable(captureFault(FAULT.SCREEN_READER_START_FAILED, "nvda.start failed: ...")), true);
});

test("a hard timeout is NOT retried locally — it has already spent the whole budget", () => {
  // Carries no fault code, so it falls through to the run, which reissues it.
  assert.equal(
    isLocallyRecoverable(new Error("capture exceeded the hard timeout of 240000 ms and was abandoned")),
    false);
});

test("an untagged error is not recoverable", () => {
  assert.equal(isLocallyRecoverable(new TypeError("x is not a function")), false);
});

test("a missing error object is not recoverable", () => {
  // Defensive: this is called on whatever a catch block caught.
  assert.equal(isLocallyRecoverable(undefined), false);
});
