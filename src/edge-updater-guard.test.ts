/**
 * `/health`'s `environment` carries `edgeUpdaterGuard` -- `{state, checkedAt, reenabled}` -- read from the record
 * the elevated guard task leaves, because this unelevated process cannot read Edge's update tasks itself (#5021).
 *
 * WHICH HALF EACH TEST PROVES, as `windows-build.test.ts` states it: the READER (`edge-updater-guard.ts`) is
 * guidepup-free and is run for real, against fixture records, an injected clock and the real filesystem. The
 * WIRING in `server.ts` cannot be imported off Windows, so it is read off the source. That a real guest's guard
 * wrote a real record is a fleet reading, and it is `orchestrator`'s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUARD_RECORD_PATH, GUARD_STALE_AFTER_MS, edgeUpdaterGuardFrom, readEdgeUpdaterGuard, unreadEdgeUpdaterGuard,
} from "./edge-updater-guard.ts";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const record = (checkedAt: string, reenabled: unknown = []) => JSON.stringify({ checkedAt, reenabled });
const stateOf = (raw: string) => edgeUpdaterGuardFrom(raw, NOW).state;

test("each of the four states, from a fixture record", () => {
  assert.deepEqual(edgeUpdaterGuardFrom(record(minutesAgo(3)), NOW),
    { state: "ok", checkedAt: minutesAgo(3), reenabled: [] });
  assert.deepEqual(edgeUpdaterGuardFrom(record(minutesAgo(3), ["task:MicrosoftEdgeUpdateTaskMachineUA"]), NOW),
    { state: "drift", checkedAt: minutesAgo(3), reenabled: ["task:MicrosoftEdgeUpdateTaskMachineUA"] });
  assert.equal(edgeUpdaterGuardFrom(record(minutesAgo(120)), NOW).state, "stale");
  assert.deepEqual(unreadEdgeUpdaterGuard("absent"), { state: "absent", checkedAt: null, reenabled: [] });
});

test("the threshold: 44 minutes reads ok and 46 reads stale, with 45 inside", () => {
  assert.equal(GUARD_STALE_AFTER_MS, 45 * MINUTE, "the row names 45 minutes");
  assert.equal(stateOf(record(minutesAgo(44))), "ok");
  assert.equal(stateOf(record(minutesAgo(45))), "ok");
  assert.equal(stateOf(record(minutesAgo(46))), "stale");
});

test("a guard that stopped is stale even when its last run found something, and the history is kept", () => {
  const verdict = edgeUpdaterGuardFrom(record(minutesAgo(46), ["service:edgeupdate"]), NOW);
  assert.equal(verdict.state, "stale");
  assert.deepEqual(verdict.reenabled, ["service:edgeupdate"]);
  // The control: the same content, fresh, is drift -- so the order above is a decision and not an accident.
  assert.equal(stateOf(record(minutesAgo(44), ["service:edgeupdate"])), "drift");
});

test("the guard's own output shape parses: a seven-digit ISO 8601 `o` timestamp and a UTF-8 BOM", () => {
  const written = `\uFEFF{\r\n  "checkedAt": "2026-10-11T11:58:30.1234567Z",\r\n  "reenabled": [\r\n\r\n  ]\r\n}`;
  assert.deepEqual(edgeUpdaterGuardFrom(written, NOW),
    { state: "ok", checkedAt: "2026-10-11T11:58:30.1234567Z", reenabled: [] });
  // PowerShell 5.1 may collapse a one-element list to a bare string; the entry is not lost.
  assert.deepEqual(edgeUpdaterGuardFrom(record(minutesAgo(1), "task:MicrosoftEdgeUpdateTaskMachineCore"), NOW).reenabled,
    ["task:MicrosoftEdgeUpdateTaskMachineCore"]);
});

test("a record that cannot be read as one is unknown and never ok", () => {
  const unreadable: Record<string, string> = {
    "empty file": "",
    "truncated": '{"checkedAt": "2026-10-11T11:5',
    "not an object": '"ok"',
    "null": "null",
    "an array": "[]",
    "no checkedAt": '{"reenabled": []}',
    "checkedAt is not a date": record("yesterday"),
    "checkedAt is a number": JSON.stringify({ checkedAt: NOW, reenabled: [] }),
    // A missing list must not read as an EMPTY one: that is a half-written record reading as "nothing came back".
    "no reenabled": JSON.stringify({ checkedAt: minutesAgo(1) }),
    "reenabled is null": JSON.stringify({ checkedAt: minutesAgo(1), reenabled: null }),
    "reenabled holds a non-string": record(minutesAgo(1), [1]),
  };
  for (const [what, raw] of Object.entries(unreadable)) {
    const verdict = edgeUpdaterGuardFrom(raw, NOW);
    assert.equal(verdict.state, "unknown", `${what} was read as ${verdict.state}`);
    assert.equal(verdict.checkedAt, null, `${what} reported a time it could not have read`);
  }
});

test("a timestamp ahead of this box's clock is a moved clock: tolerated a little, then unknown", () => {
  const ahead = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
  assert.equal(stateOf(record(ahead(4))), "ok");
  assert.equal(stateOf(record(ahead(6))), "unknown", "a record from the future must not read ok for as long as it lasts");
});

test("an unread guard is a fresh unknown each time", () => {
  assert.equal(unreadEdgeUpdaterGuard().state, "unknown");
  const first = unreadEdgeUpdaterGuard();
  first.reenabled.push("task:x");
  assert.deepEqual(unreadEdgeUpdaterGuard().reenabled, [], "one shared literal would carry a caller's push for ever");
});

test("the real read: a record on disk is read, a missing one is absent, and another failure is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edge-updater-guard-"));
  try {
    const path = join(dir, "edge-updater-guard.json");
    writeFileSync(path, `\uFEFF${record(minutesAgo(2), ["task:MicrosoftEdgeUpdateTaskMachineUA"])}`, "utf8");
    const read = await readEdgeUpdaterGuard({ path, now: () => NOW });
    assert.equal(read.state, "drift", "the positive control: a real file through the real reader");

    assert.equal((await readEdgeUpdaterGuard({ path: join(dir, "no-such-record.json") })).state, "absent");
    // A directory where a file should be: a read failure that is NOT "no record", so it must not read as one.
    assert.equal((await readEdgeUpdaterGuard({ path: dir })).state, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only ENOENT is absent: access denied and a sharing violation are unknown", async () => {
  const failing = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
  assert.equal((await readEdgeUpdaterGuard({ read: failing("ENOENT") })).state, "absent");
  for (const code of ["EACCES", "EPERM", "EBUSY", "EISDIR", "EMFILE"]) {
    assert.equal((await readEdgeUpdaterGuard({ read: failing(code) })).state, "unknown", code);
  }
  const noCode = async () => { throw new Error("no code at all"); };
  assert.equal((await readEdgeUpdaterGuard({ read: noCode })).state, "unknown");
});

test("the reader reads the path the guard task writes", () => {
  assert.equal(GUARD_RECORD_PATH, "C:\\ProgramData\\a11ign\\edge-updater-guard.json");
});

const server = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");
const bodyOf = (name: string) =>
  new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(server)?.[0] ?? "";

test("server.ts reads the record on the version sampler's tick, unmemoised, starting unknown", () => {
  const refresh = bodyOf("refreshEdgeUpdaterGuard");
  assert.ok(refresh.length > 0, "refreshEdgeUpdaterGuard not found; this scan is broken, not passing");
  assert.match(refresh, /await readEdgeUpdaterGuard\(\)/);
  assert.doesNotMatch(refresh, /bootConstants/, "the record changes every guard run: a memo is the stale answer");
  assert.match(server, /let edgeUpdaterGuard = unreadEdgeUpdaterGuard\(\);/,
    "a worker that has not read the record yet must not have been seen ok");
  assert.match(server, /readWindowsVersion: async \(\) => \{[\s\S]*?refreshEdgeUpdaterGuard\(\)/,
    "the record is not read on the version sampler's tick");
});

test("currentEnvironment serves edgeUpdaterGuard on every call, after the 5 s cache", () => {
  const current = bodyOf("currentEnvironment");
  assert.ok(current.length > 0, "currentEnvironment not found; this scan is broken, not passing");
  assert.ok(current.indexOf("edgeUpdaterGuard,") > current.indexOf("runtimeEnvironment()"),
    "edgeUpdaterGuard must be merged AFTER the cache decision, or a reading is frozen into it for 5 s");
  assert.doesNotMatch(bodyOf("runtimeEnvironment"), /edgeUpdaterGuard/, "the 5 s cache must not hold the record");
});
