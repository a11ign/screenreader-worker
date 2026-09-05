/**
 * AN ABANDONED `prepareDesktop` KEEPS RUNNING, and until now it kept WRITING.
 *
 * `server.mjs` races `prepareDesktop` against a 60 s timeout and continues the capture either way — the
 * right call, since a desktop we could not tidy is not a reason to refuse a page. But losing that race does
 * not cancel the underlying promise: nothing in JS stops an `await` chain because its caller gave up on it.
 * So a `prepareDesktop` call that overran kept running in the background, and when it eventually finished it
 * was about to overwrite `dialogCache`/`foregroundCache` — module globals `/health` reads for EVERY capture,
 * not just the one that started this call — with a snapshot that is stale by however long it overran,
 * stamped with a fresh `Date.now()` as if it had just been sampled. A capture running right now would then
 * have its worker report readiness from a desktop state describing a moment during a DIFFERENT capture's
 * preparation.
 *
 * Confirmed, not assumed: `dialogCache`/`foregroundCache` are read only inside `readiness()` (`/health`),
 * never merged into `marks`/`result.diagnostics`. So this is a confusing `/health` signal, never a corrupted
 * capture RESULT — reachable only in the case the timeout already defends against, which is why it sat on
 * `docs/backlog.md` as an opportunity rather than a defect.
 *
 * A FENCE, not real cancellation: `prepareDesktop` now takes an `AbortSignal` and checks it after each
 * await, before the write that await's result would otherwise feed. Real cancellation of the underlying
 * PowerShell child would change the capture's own timing and failure surface and wants a live capture to
 * validate; a fence is testable offline, which is the whole point of this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareDesktop, desktopCachesForTest } from "./desktop-prepare.mjs";

/** A mark array, typed loosely to match what `prepareDesktop` actually pushes. */
const marks = (): Record<string, unknown>[] => [];

test("prepareDesktop still writes both caches when nothing abandons it — the regression guard", async () => {
  // Not merely "does the fence work" — the fence must be INVISIBLE on the path every real capture takes,
  // where `signal` is never aborted. A fence that also gated the happy path would be the exact "confused
  // diagnostic" this project has already paid for once, in a different shape.
  const before = desktopCachesForTest();
  const found: Record<string, unknown>[] = marks();
  await prepareDesktop(found, undefined, {
    dismissBlockingDialogs: async () => ({ dismissed: [] }),
    probeWindowOwner: async () => ({ title: "Microsoft Edge", owner: "msedge.exe", ok: true }),
  });
  const after = desktopCachesForTest();
  assert.notEqual(after.dialogCache, before.dialogCache, "the dialog cache must still be refreshed normally");
  assert.notEqual(after.foregroundCache, before.foregroundCache, "and the foreground cache too");
  assert.deepEqual(found, [], "nothing dismissed and no blocker held, so no mark is expected either");
});

test("a signal already aborted before prepareDesktop starts drops BOTH writes, and says so", async () => {
  // The full-early-abandonment case: the timeout fired before either PowerShell call had returned. Both
  // calls still run to completion — they are already in flight and cannot be interrupted mid-call — but
  // neither of their results may reach the shared caches.
  const controller = new AbortController();
  controller.abort();
  const before = desktopCachesForTest();
  const found: Record<string, unknown>[] = marks();
  await prepareDesktop(found, controller.signal, {
    dismissBlockingDialogs: async () => ({ dismissed: [{ handle: "1", title: "Error", message: "x", owner: "y" }] }),
    probeWindowOwner: async () => ({ title: "Notepad", owner: "notepad.exe", ok: false }),
  });
  const after = desktopCachesForTest();
  assert.equal(after.dialogCache, before.dialogCache,
    "an abandoned call must not overwrite the live dialog cache with a stale snapshot");
  assert.equal(after.foregroundCache, before.foregroundCache,
    "nor the foreground cache -- a later capture's /health would read this call's stale answer as fresh");
  assert.deepEqual(found, [{ event: "desktopPrepareAbandoned", atMs: 0, after: "dismissBlockingDialogs" }],
    "a remedy with no mark cannot be told apart from one that never ran -- refreshBrowseBuffer's own lesson");
});

test("abandonment mid-flight, between the two writes, drops only the SECOND one", async () => {
  // The realistic shape: the 60 s timeout fires while the SECOND PowerShell call (the foreground probe) is
  // in flight, after the first (dialog dismissal) has already safely landed. `dialogCache` must still be
  // refreshed -- that information is not stale, it arrived before the deadline -- and only `foregroundCache`
  // is dropped.
  const controller = new AbortController();
  const before = desktopCachesForTest();
  const found: Record<string, unknown>[] = marks();
  await prepareDesktop(found, controller.signal, {
    dismissBlockingDialogs: async () => ({ dismissed: [] }),
    probeWindowOwner: async () => {
      // Simulates the external timeout firing WHILE this exact call is outstanding -- the realistic case,
      // never reachable by aborting before the call starts.
      controller.abort();
      return { title: "Notepad", owner: "notepad.exe", ok: false };
    },
  });
  const after = desktopCachesForTest();
  assert.notEqual(after.dialogCache, before.dialogCache,
    "the dialog cache landed before the deadline and must be kept");
  assert.equal(after.foregroundCache, before.foregroundCache,
    "the foreground cache arrived after the deadline and must be dropped");
  assert.deepEqual(found, [{ event: "desktopPrepareAbandoned", atMs: 0, after: "probeWindowOwner" }]);
});
