// The logger produced this project's most expensive non-evidence defect: a 354 GB `server.log` holding one
// repeated EPIPE stack trace, written by the uncaughtException handler logging about a broken stdout pipe
// over that same broken pipe. Every assertion here fails against the code that shipped it, which is the only
// reason to trust them — a guard that was never shown to fail is not a guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { createLogWriter, MAX_LOG_BYTES, silenceStreamErrors } from "./server-log.mjs";

/** A fake for every side effect the writer has, so a test can watch all of them and touch no real disk. */
function spyIo(overrides = {}) {
  const calls = { appended: [] as string[], renames: [] as string[], console: [] as string[] };
  return {
    calls,
    io: {
      append: (_path: string, text: string) => void calls.appended.push(text),
      rename: (from: string, to: string) => void calls.renames.push(`${from} -> ${to}`),
      size: () => 0,
      writeConsole: (text: string) => void calls.console.push(text),
      ...overrides,
    },
  };
}

test("the log is bounded WITHIN one process lifetime, not only at boot", () => {
  // The whole defect. Rotation used to run once, from server.listen, so a writer that never restarted could
  // grow without limit — and the loop that filled a disk did all of it inside one process.
  const { calls, io } = spyIo();
  const log = createLogWriter({ path: "server.log", maxBytes: 100, io });

  for (let i = 0; i < 40; i++) log("aaaaaaaaa"); // 10 bytes a line with the newline

  assert.ok(calls.renames.length >= 3, `expected repeated rotation, got ${calls.renames.length}`);
  // One generation, always the same name, so a rotation can never accumulate files of its own.
  assert.deepEqual([...new Set(calls.renames)], ["server.log -> server.log.1"]);
});

test("a rotation happens BEFORE the append, so the first line after it survives", () => {
  // A boot-time rotation used to retire the file and then write "listening on :8765" into the generation it
  // had just retired, so the fresh log opened with no record of the worker starting.
  const { calls, io } = spyIo({ size: () => MAX_LOG_BYTES + 1 });
  const log = createLogWriter({ path: "server.log", io });

  log("listening on :8765");

  assert.deepEqual(calls.renames, ["server.log -> server.log.1"]);
  assert.deepEqual(calls.appended, ["listening on :8765\n"]);
});

test("a broken console pipe never escapes the logger", () => {
  // EPIPE from process.stdout.write used to propagate out of log(), reach the uncaughtException handler, and
  // be reported by calling log() again. This is the loop, closed at its source.
  const { calls, io } = spyIo({
    writeConsole: () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    },
  });
  const log = createLogWriter({ path: "server.log", io });

  assert.doesNotThrow(() => log("SIGTERM: stopping NVDA before exit"));
  // The file is the fallback, so the line is still recorded — a dead console must not cost us the evidence.
  assert.deepEqual(calls.appended, ["SIGTERM: stopping NVDA before exit\n"]);
});

test("a failing rotation does not recurse, and does not retry on every line", () => {
  // Rotation reports its own failure. Reporting it through the logger would be mutual recursion, since
  // rotation is reached FROM the logger.
  const { calls, io } = spyIo({
    rename: () => {
      throw new Error("EACCES");
    },
  });
  const log = createLogWriter({ path: "server.log", maxBytes: 100, io });

  for (let i = 0; i < 40; i++) log("aaaaaaaaa");

  // 40 lines of 10 bytes against a 100-byte budget is a handful of attempts, not one per line.
  assert.ok(calls.renames.length <= 5, `rename attempted ${calls.renames.length} times; expected it to back off`);
  assert.equal(calls.appended.length, 40, "every line must still reach the file");
});

test("rotating when no log file exists is a no-op, not an error loop", () => {
  // `statSync(path, { throwIfNoEntry: false })?.size <= max` is FALSE when the file is absent, because
  // `undefined <= n` is false. The old guard therefore fell through to renameSync on a missing file.
  const { calls, io } = spyIo({ size: () => 0 });
  const log = createLogWriter({ path: "server.log", io });

  log("a fresh worker with no log on disk");

  assert.deepEqual(calls.renames, []);
  assert.deepEqual(calls.appended, ["a fresh worker with no log on disk\n"]);
});

test("a console that throws AND a rotation that fails still cannot take the worker down", () => {
  const { calls, io } = spyIo({
    writeConsole: () => {
      throw new Error("write EPIPE");
    },
    rename: () => {
      throw new Error("EACCES");
    },
  });
  const log = createLogWriter({ path: "server.log", maxBytes: 10, io });

  assert.doesNotThrow(() => {
    for (let i = 0; i < 20; i++) log("both channels are broken");
  });
  assert.equal(calls.appended.length, 20);
});

test("silenceStreamErrors stops an async stream error becoming an uncaughtException", () => {
  const stream = new PassThrough();
  // Without a listener, Node escalates an 'error' event to an uncaught exception. That is the asynchronous
  // route to the same loop the writer closes synchronously.
  assert.throws(() => stream.emit("error", new Error("write EPIPE")));

  silenceStreamErrors(stream);
  assert.doesNotThrow(() => stream.emit("error", new Error("write EPIPE")));
});
