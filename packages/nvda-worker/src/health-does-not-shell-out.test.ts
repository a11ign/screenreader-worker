/**
 * `/health` must not run PowerShell, and the display facts it reports say how old they are (#2673).
 *
 * `respondWithHealth` says "nothing here may walk a disk or shell out" and its first line was
 * `currentEnvironment()`, whose 5 s rebuild ran `displayMode()` and `displayAdapter()` -- two SYNCHRONOUS
 * `powershell.exe` calls. `execFileSync` blocks Node's event loop for the whole call, so the first `/health`
 * after 5 s of quiet cost 0.53 to 0.76 s on twelve workers and 2.8 to 3.1 s on three, and the worker answered
 * nothing on any route meanwhile.
 *
 * WHICH HALF EACH TEST PROVES. `server.mjs` needs guidepup and therefore a screen reader, so no test here can
 * serve a real `/health`. The BEHAVIOUR is proved on `createDisplaySampler` (guidepup-free, a stub reader that
 * takes one second standing in for `powershell.exe`); the WIRING -- that `/health`'s path reaches the sampler and
 * not the shell-out -- is read off the source. That the real endpoint now answers in milliseconds on a real guest
 * is the fleet reading in the row's done-when 4, and it is `orchestrator`'s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createDisplaySampler } from "./display-sample.mjs";

/** The stub `powershell.exe`: it answers, but only after the time the slow boxes take. */
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
  const sampler = createDisplaySampler({
    readMode: slow("1024x768"), readAdapter: slow("Intel(R) UHD Graphics 630"), now: clock.now,
  });
  await sampler.refresh(); // the sample a running worker would already hold

  const answerMs: number[] = [];
  for (let request = 0; request < 8; request += 1) {
    clock.advance(1_000); // eight requests over 8 s, so several straddle the old 5 s cache expiry
    const before = performance.now();
    const reading = sampler.current();
    answerMs.push(performance.now() - before);
    assert.equal(reading.displayMode, "1024x768");
  }
  assert.ok(Math.max(...answerMs) < ONE_SECOND_MS / 10,
    `a request read memory and should not have waited on the reader: ${answerMs.join(", ")} ms`);
});

test("a read DURING a slow sample answers at once, and the event loop keeps turning while it runs", async () => {
  const sampler = createDisplaySampler({ readMode: slow("1024x768"), readAdapter: slow("Basic") });
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

  assert.equal(reading.displayMode, "unknown", "before the first sample lands it is unknown, not an awaited value");
  assert.ok(readMs < ONE_SECOND_MS / 10, `current() waited ${readMs} ms on an in-flight sample`);
  assert.ok(longestGapMs < ONE_SECOND_MS / 4,
    `the loop stalled for ${longestGapMs} ms during a ${ONE_SECOND_MS} ms sample; a synchronous read would be ~${ONE_SECOND_MS}`);
});

test("a sample says how old it is: null before any sample, growing with the clock, reset by the next", async () => {
  const clock = manualClock();
  const sampler = createDisplaySampler({ readMode: instant("1024x768"), readAdapter: instant("Basic"), now: clock.now });

  assert.equal(sampler.current().displaySampledMsAgo, null, "never sampled is null, which is not a zero-second-old reading");
  await sampler.refresh();
  assert.equal(sampler.current().displaySampledMsAgo, 0);
  clock.advance(7_500);
  assert.equal(sampler.current().displaySampledMsAgo, 7_500, "a stale value must read as stale");
  await sampler.refresh();
  assert.equal(sampler.current().displaySampledMsAgo, 0);
});

test("the display is still RE-READ under a running worker, so a change stays visible", async () => {
  let mode = "1024x768";
  const sampler = createDisplaySampler({ readMode: async () => mode, readAdapter: instant("Basic"), tickMs: 15 });
  sampler.start();
  await sampler.refresh();
  assert.equal(sampler.current().displayMode, "1024x768");

  mode = "640x480"; // a provisioning run set the mode under the running worker
  const deadline = performance.now() + 2_000;
  while (sampler.current().displayMode !== "640x480" && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  sampler.stop();
  assert.equal(sampler.current().displayMode, "640x480", "the timer never picked the change up");
});

test("one sample at a time, however many callers ask", async () => {
  let concurrent = 0;
  let peak = 0;
  let reads = 0;
  const overlapping = async () => {
    reads += 1; concurrent += 1; peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 40));
    concurrent -= 1;
    return "1024x768";
  };
  const sampler = createDisplaySampler({ readMode: overlapping, readAdapter: instant("Basic"), tickMs: 1 });
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
  const counting = async () => { reads += 1; return "1024x768"; };
  const sampler = createDisplaySampler({ readMode: counting, readAdapter: instant("Basic"), tickMs: 50 });
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
    return "1024x768";
  };
  const sampler = createDisplaySampler({ readMode: slowCounting, readAdapter: instant("Basic"), tickMs: 10 });
  sampler.start(); // the first sample is now in flight
  sampler.stop();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(reads, 1, "a stopped sampler went on sampling after its in-flight sample finished");
});

test("a reader that throws is contained: the other fact survives and the failed one reads unknown", async () => {
  const sampler = createDisplaySampler({
    readMode: () => Promise.reject(new Error("PowerShell exploded")), readAdapter: instant("Basic"),
  });
  await sampler.refresh();
  assert.deepEqual({ ...sampler.current(), displaySampledMsAgo: 0 },
    { displayMode: "unknown", displayAdapter: "Basic", displaySampledMsAgo: 0 });
});

// ---- the wiring: what `/health`'s path reaches, read off the source ----

const server = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");
const bodyOf = (name: string) =>
  new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(server)?.[0] ?? "";

test("the environment /health serves is built without the synchronous display reads", () => {
  const build = bodyOf("runtimeEnvironment");
  assert.ok(build.length > 0, "runtimeEnvironment not found; this scan is broken, not passing");
  assert.doesNotMatch(build, /\bdisplayMode\(|\bdisplayAdapter\(/,
    "runtimeEnvironment (rebuilt on /health's request path) calls a display read again");
  assert.doesNotMatch(build, /displayMode:|displayAdapter:/,
    "the display fields belong to the sampler, which carries their age; a copy here would be frozen in the 5 s cache");
});

test("currentEnvironment merges the sampler's reading in on every call, after the cache", () => {
  const current = bodyOf("currentEnvironment");
  assert.ok(current.length > 0, "currentEnvironment not found; this scan is broken, not passing");
  const merge = current.indexOf("displaySampler.current()");
  assert.ok(merge > current.indexOf("runtimeEnvironment()"),
    "the sampler's reading must be merged AFTER the cache decision, or its age freezes for up to 5 s");
});

test("neither display read can shell out synchronously", () => {
  for (const name of ["displayMode", "displayAdapter", "sampledValue"]) {
    const body = bodyOf(name);
    assert.ok(body.length > 0, `${name} not found; this scan is broken, not passing`);
    assert.doesNotMatch(body, /powershellValue\(|execFileSync|spawnSync/,
      `${name} blocks the event loop for the whole PowerShell call`);
  }
  assert.match(bodyOf("displayMode"), /await sampledValue\(/);
  assert.match(bodyOf("displayAdapter"), /await sampledValue\(/);
});

test("the sampler is started only with the listener, and stopped with the process", () => {
  assert.match(server, /if \(IS_MAIN\) displaySampler\.start\(\)/,
    "a process that merely imports server.mjs must not run a PowerShell timer");
  assert.match(server, /displaySampler\.stop\(\)/, "SIGINT/SIGTERM must stop the timer");
});
