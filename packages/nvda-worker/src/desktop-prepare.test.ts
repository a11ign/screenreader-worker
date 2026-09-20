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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prepareDesktop, desktopCachesForTest, sampleDesktopDialogs, foregroundWatchTick,
  FOREGROUND_CLEAR_MIN_INTERVAL_MS } from "./desktop-prepare.mjs";

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

/**
 * THE BACKGROUND WATCH — #1815: `prepareDesktop` only runs at the START of a capture, so a foreground
 * holder it could not clear (or one that arrives after the last capture ends) sits until the NEXT
 * capture — which a held worker never receives, because it reports `not ready`. `foregroundWatchTick` is
 * the off-path timer that reaches it instead: see its own header for why this is never wired into
 * `readiness()`.
 */

test("a clean cache: the watch attempts nothing -- the positive control this row exists for", async () => {
  // Warming for seconds is normal startup, not a finding, and the same is true of the watch: an idle
  // desktop with nothing cached must call no PowerShell at all.
  await sampleDesktopDialogs({
    listBlockingDialogs: async () => [],
    probeWindowOwner: async () => ({ title: "", owner: "explorer.exe", handle: "5", ok: true }),
  });
  let called = false;
  const next = await foregroundWatchTick(null, Date.now(), {
    dismissForegroundBlocker: async () => { called = true; return true; },
  });
  assert.equal(called, false, "nothing is holding the foreground, so nothing needed clearing");
  assert.equal(next, null, "no attempt was made, so the rate-limit state must not advance");
});

test("a cached blocker is cleared on the first tick, with no prior attempt to rate-limit against", async () => {
  await sampleDesktopDialogs({
    listBlockingDialogs: async () => [],
    probeWindowOwner: async () => (
      { title: "New notification", owner: "ShellExperienceHost.exe", handle: "42", ok: true }
    ),
  });
  let dismissedHandle: string | undefined;
  const now = Date.now();
  const next = await foregroundWatchTick(null, now, {
    dismissForegroundBlocker: async (handle) => { dismissedHandle = handle; return true; },
  });
  assert.equal(dismissedHandle, "42", "the clear must act on the SAME window the last sample identified");
  assert.equal(next, now, "an attempt was made, so the rate-limit state must record when");
});

test("the watch is RATE-LIMITED: a tick inside the cooldown makes no new attempt", async () => {
  await sampleDesktopDialogs({
    listBlockingDialogs: async () => [],
    probeWindowOwner: async () => (
      { title: "New notification", owner: "ShellExperienceHost.exe", handle: "42", ok: true }
    ),
  });
  const firstAttempt = Date.now();
  let attempts = 0;
  const deps = { dismissForegroundBlocker: async () => { attempts += 1; return false; } };
  const stillFirst = await foregroundWatchTick(
    firstAttempt, firstAttempt + FOREGROUND_CLEAR_MIN_INTERVAL_MS - 1, deps,
  );
  assert.equal(attempts, 0,
    "a worker correctly held by something dismissForeground cannot clear must not spin PowerShell forever");
  assert.equal(stillFirst, firstAttempt, "the rate-limit state is unchanged when no attempt was made");
});

test("past the cooldown, the watch tries again", async () => {
  await sampleDesktopDialogs({
    listBlockingDialogs: async () => [],
    probeWindowOwner: async () => (
      { title: "New notification", owner: "ShellExperienceHost.exe", handle: "42", ok: true }
    ),
  });
  const firstAttempt = Date.now();
  let attempts = 0;
  const secondAttemptAt = firstAttempt + FOREGROUND_CLEAR_MIN_INTERVAL_MS;
  const next = await foregroundWatchTick(firstAttempt, secondAttemptAt, {
    dismissForegroundBlocker: async () => { attempts += 1; return true; },
  });
  assert.equal(attempts, 1, "the cooldown has fully elapsed, so a second attempt is due");
  assert.equal(next, secondAttemptAt);
});

test("#1815: readiness() itself never reaches the foreground-clearing path", () => {
  // `readiness()` lives in `server.mjs`, which imports guidepup transitively and cannot be imported here
  // -- this module's own header explains why. So this reads the function's OWN source text instead of
  // importing it, sliced between its declaration and the next top-level function, exactly the boundary a
  // reader would use to answer "what does readiness() call".
  const serverSource = readFileSync(
    fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8",
  );
  const start = serverSource.indexOf("async function readiness()");
  assert.ok(start >= 0, "readiness() must still exist under that name for this slice to mean anything");
  const end = serverSource.indexOf("\nasync function", start + 1);
  const readinessSource = serverSource.slice(start, end === -1 ? undefined : end);
  assert.ok(!readinessSource.includes("dismissForegroundBlocker"),
    "readiness() must never call the shell-out that clears a foreground holder -- #1815's ruling refuses "
    + "wiring the clear into /health's own request path; only the background watch may call it");
  assert.ok(!readinessSource.includes("foregroundWatchTick"),
    "readiness() must not even reach the watch's tick function -- it only ever reads foregroundCache, "
    + "the same live binding it already read before this row");
});
