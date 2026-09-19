/**
 * A FOREGROUND HOLDER IS DETECTED AND NEVER CLEARED — #1733.
 *
 * `a11y-worker-4` sat blocked for 4.9 days, 0 captures: `prepareDesktop` found a `ShellExperienceHost`
 * toast holding the foreground, logged it, pushed a `foregroundBlocked` mark, and moved on. Nothing ever
 * asked the desktop to give the foreground back, so the toast survived every capture attempt indefinitely
 * and `noForegroundBlocker` never had a chance to self-heal the way `noBlockingDialog` does at the start
 * of the very next capture.
 *
 * The fix mirrors `dismissBlockingDialogs`'s own shape: a foreground holder is now CLEARED, not only
 * recorded, and clearing it is bounded and degrade-safe -- a failure to clear must never throw, and the
 * capture must still be attempted on a desktop that could not be tidied. That is the existing rule the
 * dialog path already follows one function up, so this file exists to pin the SAME rule for the half that
 * was missing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareDesktop, desktopCachesForTest } from "./desktop-prepare.mjs";

/** A mark array, typed loosely to match what `prepareDesktop` actually pushes. */
const marks = (): Record<string, unknown>[] => [];

test("a foreground holder is CLEARED, not only recorded", async () => {
  const found: Record<string, unknown>[] = marks();
  let dismissedHandle: string | undefined;
  await prepareDesktop(found, undefined, {
    dismissBlockingDialogs: async () => ({ dismissed: [] }),
    probeWindowOwner: async () => (
      { title: "New notification", owner: "ShellExperienceHost.exe", handle: "77", ok: true }
    ),
    dismissForegroundBlocker: async (handle) => {
      dismissedHandle = handle;
      return true;
    },
  });
  assert.equal(dismissedHandle, "77", "the clear must act on the SAME window the probe just identified");
  assert.deepEqual(found, [{
    event: "foregroundBlocked", atMs: 0,
    owner: "ShellExperienceHost.exe", title: "New notification", cleared: true,
  }], "the mark must say the holder was found AND that it was cleared");
});

test("a failure to clear degrades to \"did nothing\" and never throws", async () => {
  const found: Record<string, unknown>[] = marks();
  await assert.doesNotReject(prepareDesktop(found, undefined, {
    dismissBlockingDialogs: async () => ({ dismissed: [] }),
    probeWindowOwner: async () => (
      { title: "New notification", owner: "ShellExperienceHost.exe", handle: "77", ok: true }
    ),
    dismissForegroundBlocker: async () => false,
  }));
  assert.deepEqual(found, [{
    event: "foregroundBlocked", atMs: 0,
    owner: "ShellExperienceHost.exe", title: "New notification", cleared: false,
  }], "a failed clear is still recorded, and recorded as failed -- the capture proceeds regardless");
});

test("an ordinary idle desktop calls no dismissal at all", async () => {
  const found: Record<string, unknown>[] = marks();
  let dismissCalled = false;
  await prepareDesktop(found, undefined, {
    dismissBlockingDialogs: async () => ({ dismissed: [] }),
    probeWindowOwner: async () => ({ title: "", owner: "explorer.exe", handle: "5", ok: true }),
    dismissForegroundBlocker: async () => { dismissCalled = true; return true; },
  });
  assert.equal(dismissCalled, false, "nothing was holding the foreground, so nothing needed clearing");
  assert.deepEqual(found, [], "no blocker, no mark");
});

test("prepareDesktop still writes the foreground cache when it clears a holder", async () => {
  // The regression guard `prepare-desktop-abandon.test.ts` already pins that both caches are written on
  // the happy path with no blocker present; this pins that clearing a blocker does not skip that write.
  const before = desktopCachesForTest();
  const found: Record<string, unknown>[] = marks();
  await prepareDesktop(found, undefined, {
    dismissBlockingDialogs: async () => ({ dismissed: [] }),
    probeWindowOwner: async () => (
      { title: "New notification", owner: "ShellExperienceHost.exe", handle: "9", ok: true }
    ),
    dismissForegroundBlocker: async () => true,
  });
  const after = desktopCachesForTest();
  assert.notEqual(after.foregroundCache, before.foregroundCache);
});
