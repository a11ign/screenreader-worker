/**
 * `/health` must not run PowerShell for `windowsVersion`, `screenReaderVersion` or `browserVersion` either
 * (#2684 -- the #2673 stall again, for the other three reads).
 *
 * `runtimeEnvironment`'s 5 s rebuild called `bootConstant("$os = ...")` and `fileProductVersion(nvdaPath)` /
 * `fileProductVersion(browserPath)` straight from `/health`'s request path. All three degrade to
 * `"unknown"` on a failed read rather than throwing, but neither memoises a failure -- and `fileProductVersion`
 * also re-reads whenever the file's mtime/size changes, on purpose, so an Edge or NVDA update under a
 * running worker is still noticed. So a box that could not answer one of the three re-ran `powershell.exe`,
 * SYNCHRONOUSLY, on every 5 s rebuild for as long as it could not -- and `execFileSync` blocks Node's event
 * loop for the whole call, so the worker answered nothing on any route meanwhile. Filed on top of #2678,
 * which fixed the same defect for `displayMode`/`displayAdapter` and left these three, found on the same row.
 *
 * WHICH HALF EACH TEST PROVES, exactly as `health-does-not-shell-out.test.ts` states it: `server.mjs` needs
 * guidepup and therefore a screen reader, so no test here can serve a real `/health`. The BEHAVIOUR is
 * proved on `createVersionSampler` (`file-version.mjs`, guidepup-free, with stub readers standing in for
 * `powershell.exe`); the WIRING -- that `/health`'s path reaches the sampler and not the shell-out -- is
 * read off `server.mjs`'s source. That the real endpoint answers in milliseconds on a real guest is
 * `orchestrator`'s to read on the fleet, the same way #2673's was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createVersionSampler } from "./file-version.mjs";

/** The stub `powershell.exe`: it answers, but only after the time a box that cannot read a value takes. */
const ONE_SECOND_MS = 1_000;
const slow = (value: string) => () => new Promise<string>((done) => setTimeout(() => done(value), ONE_SECOND_MS));
const instant = (value: string) => () => Promise.resolve(value);

/** A clock the test moves by hand, so "spread across more than 5 s" costs no wall time. */
function manualClock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

test("a burst of reads spread across more than 5 s answers in well under the stub's one second", async () => {
  const clock = manualClock();
  const sampler = createVersionSampler({
    readWindowsVersion: slow("unknown"), readScreenReaderVersion: slow("unknown"),
    readBrowserVersion: slow("unknown"), now: clock.now,
  });
  await sampler.refresh(); // the sample a running worker would already hold

  const answerMs: number[] = [];
  for (let request = 0; request < 8; request += 1) {
    clock.advance(1_000); // eight requests over 8 s, so several straddle the old 5 s cache expiry
    const before = performance.now();
    const reading = sampler.current();
    answerMs.push(performance.now() - before);
    assert.equal(reading.windowsVersion, "unknown");
  }
  assert.ok(Math.max(...answerMs) < ONE_SECOND_MS / 10,
    `a request read memory and should not have waited on the reader: ${answerMs.join(", ")} ms`);
});

test("a read DURING a slow sample answers at once, and the event loop keeps turning while it runs", async () => {
  const sampler = createVersionSampler({
    readWindowsVersion: slow("Microsoft Windows 11 Pro 10.0.22621"),
    readScreenReaderVersion: slow("2026.1.1"), readBrowserVersion: slow("151.0.4129.93"),
  });
  const inFlight = sampler.refresh();

  // The old shape blocked here: nothing else in the process ran until PowerShell returned.
  let lastBeat = performance.now();
  let longestGapMs = 0;
  const heartbeat = setInterval(() => {
    const at = performance.now();
    longestGapMs = Math.max(longestGapMs, at - lastBeat);
    lastBeat = at;
  }, 10);
  const before = performance.now();
  const reading = sampler.current();
  const readMs = performance.now() - before;
  await inFlight;
  clearInterval(heartbeat);

  assert.equal(reading.windowsVersion, "unknown", "before the first sample lands it is unknown, not an awaited value");
  assert.ok(readMs < ONE_SECOND_MS / 10, `current() waited ${readMs} ms on an in-flight sample`);
  assert.ok(longestGapMs < ONE_SECOND_MS / 4,
    `the loop stalled for ${longestGapMs} ms during a ${ONE_SECOND_MS} ms sample; a synchronous read would be ~${ONE_SECOND_MS}`);
});

test("a sample says how old it is: null before any sample, growing with the clock, reset by the next", async () => {
  const clock = manualClock();
  const sampler = createVersionSampler({
    readWindowsVersion: instant("Microsoft Windows 11 Pro 10.0.22621"),
    readScreenReaderVersion: instant("2026.1.1"), readBrowserVersion: instant("151.0.4129.93"), now: clock.now,
  });

  assert.equal(sampler.current().versionsSampledMsAgo, null, "never sampled is null, which is not a zero-second-old reading");
  await sampler.refresh();
  assert.equal(sampler.current().versionsSampledMsAgo, 0);
  clock.advance(7_500);
  assert.equal(sampler.current().versionsSampledMsAgo, 7_500, "a stale value must read as stale");
  await sampler.refresh();
  assert.equal(sampler.current().versionsSampledMsAgo, 0);
});

test("the version is still RE-READ under a running worker, so a change stays visible", async () => {
  let browserVersion = "151.0.4129.93";
  const sampler = createVersionSampler({
    readWindowsVersion: instant("Microsoft Windows 11 Pro 10.0.22621"), readScreenReaderVersion: instant("2026.1.1"),
    readBrowserVersion: async () => browserVersion, tickMs: 15,
  });
  sampler.start();
  await sampler.refresh();
  assert.equal(sampler.current().browserVersion, "151.0.4129.93");

  browserVersion = "151.0.4129.101"; // Edge updates under the running worker
  const deadline = performance.now() + 2_000;
  while (sampler.current().browserVersion !== "151.0.4129.101" && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  sampler.stop();
  assert.equal(sampler.current().browserVersion, "151.0.4129.101", "the timer never picked the change up");
});

test("one sample at a time, however many callers ask", async () => {
  let concurrent = 0;
  let peak = 0;
  let reads = 0;
  const overlapping = async () => {
    reads += 1; concurrent += 1; peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 40));
    concurrent -= 1;
    return "unknown";
  };
  const sampler = createVersionSampler({
    readWindowsVersion: overlapping, readScreenReaderVersion: instant("2026.1.1"),
    readBrowserVersion: instant("151.0.4129.93"), tickMs: 1,
  });
  // Three callers at once, the way a timer tick and an explicit refresh could collide on a slow guest.
  await Promise.all([sampler.refresh(), sampler.refresh(), sampler.refresh()]);
  assert.equal(reads, 1, "concurrent callers must share the one sample in flight");

  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  sampler.stop();
  assert.equal(peak, 1, "a slow guest must not stack PowerShell children");
  assert.ok(reads >= 3, `the timer never re-sampled (reads: ${reads}); the assertions above proved nothing`);
});

test("stop() ends the timer, including a tick already scheduled", async () => {
  let reads = 0;
  const counting = async () => { reads += 1; return "unknown"; };
  const sampler = createVersionSampler({
    readWindowsVersion: counting, readScreenReaderVersion: instant("2026.1.1"),
    readBrowserVersion: instant("151.0.4129.93"), tickMs: 50,
  });
  sampler.start();
  await sampler.refresh(); // the first sample has landed, so the next tick is now scheduled 50 ms out
  const beforeStop = reads;
  sampler.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(reads, beforeStop, "stop() left a scheduled tick running");
});

test("stop() during a sample in flight does not let that sample schedule another", async () => {
  let reads = 0;
  const slowCounting = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    return "unknown";
  };
  const sampler = createVersionSampler({
    readWindowsVersion: slowCounting, readScreenReaderVersion: instant("2026.1.1"),
    readBrowserVersion: instant("151.0.4129.93"), tickMs: 10,
  });
  sampler.start(); // the first sample is now in flight
  sampler.stop();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(reads, 1, "a stopped sampler went on sampling after its in-flight sample finished");
});

test("a reader that throws is contained: the other two survive and the failed one reads unknown", async () => {
  const sampler = createVersionSampler({
    readWindowsVersion: () => Promise.reject(new Error("PowerShell exploded")),
    readScreenReaderVersion: instant("2026.1.1"), readBrowserVersion: instant("151.0.4129.93"),
  });
  await sampler.refresh();
  assert.deepEqual({ ...sampler.current(), versionsSampledMsAgo: 0 }, {
    windowsVersion: "unknown", screenReaderVersion: "2026.1.1", browserVersion: "151.0.4129.93",
    versionsSampledMsAgo: 0,
  });
});

// ---- the wiring: what `/health`'s path reaches, read off the source ----

const server = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");
const bodyOf = (name: string) =>
  new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(server)?.[0] ?? "";

test("the environment /health serves is built without the synchronous version reads", () => {
  const build = bodyOf("runtimeEnvironment");
  assert.ok(build.length > 0, "runtimeEnvironment not found; this scan is broken, not passing");
  assert.doesNotMatch(build, /\bbootConstant\(|\bfileProductVersion\(/,
    "runtimeEnvironment (rebuilt on /health's request path) calls a version read again");
  assert.doesNotMatch(build, /windowsVersion:|screenReaderVersion:|browserVersion:/,
    "the version fields belong to the sampler, which carries their age; a copy here would be frozen in the 5 s cache");
});

test("currentEnvironment merges the version sampler's reading in on every call, after the cache", () => {
  const current = bodyOf("currentEnvironment");
  assert.ok(current.length > 0, "currentEnvironment not found; this scan is broken, not passing");
  const merge = current.indexOf("versionSampler.current()");
  assert.ok(merge > current.indexOf("runtimeEnvironment()"),
    "the sampler's reading must be merged AFTER the cache decision, or its age freezes for up to 5 s");
});

test("windowsVersion's own read cannot shell out synchronously", () => {
  // `powershellValue`/`execFileSync` DO still appear in server.mjs -- `foregroundLockTimeout` uses them,
  // deliberately, because it reads exactly once, ever, and is not this row's subject. Scoped to
  // `bootConstantAsync`'s own body so that read does not make this test meaningless.
  const body = bodyOf("bootConstantAsync");
  assert.ok(body.length > 0, "bootConstantAsync not found; this scan is broken, not passing");
  assert.doesNotMatch(body, /powershellValue\(|execFileSync|spawnSync/,
    "bootConstantAsync blocks the event loop for the whole PowerShell call");
  assert.match(body, /await sampledValue\(/);
});

test("the version sampler is started only with the listener, and stopped with the process", () => {
  assert.match(server, /if \(IS_MAIN\) versionSampler\.start\(\)/,
    "a process that merely imports server.mjs must not run a PowerShell timer");
  assert.match(server, /versionSampler\.stop\(\)/, "SIGINT/SIGTERM must stop the timer");
});
