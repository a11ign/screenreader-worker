// @ts-check
/**
 * The worker's log: the console AND a file, bounded within a SINGLE process lifetime.
 *
 * ## Why this is not in server.mjs
 *
 * `server.mjs` needs guidepup, so anything decided inside it is decided where no test without a screen
 * reader can reach — it does NOT bind a port on import, which the `IS_MAIN` guard settled and this
 * sentence outlived in six files (verified 2026-09-05) —
 * the same reason `capture-results.mjs` exists. That mattered here: the fault below ran to completion with
 * every check green, and there was no seam at which to prove a guard against it works.
 *
 * ## The fault this exists for
 *
 * Logging wrote to stdout OUTSIDE the `try` that guarded the file append, under a comment explaining that
 * "a failed append must not take the worker down". The append was never the risk. A worker whose parent has
 * gone away — after SIGTERM, or when the launcher's console closes — has a broken stdout pipe, and writing
 * to it raises EPIPE. That reaches the `uncaughtException` handler, which LOGS, which writes to the same
 * broken pipe, which raises EPIPE.
 *
 * That is not a leak, it is an unbounded loop appending its own stack trace as fast as the disk accepts it.
 * Observed on a developer Mac: `server.log` at 380,204,705,830 bytes — 354 GB, the host's entire free space
 * — holding one repeated EPIPE trace and nothing else. The first line of the file is `SIGTERM: stopping NVDA
 * before exit`, which is the whole story: the parent went away, and every log call after it looped.
 *
 * ## Why rotation did not save it
 *
 * `MAX_LOG_BYTES` existed throughout. It was enforced by a `rotateLogIfLarge()` called ONCE, from
 * `server.listen`. A boot-time stat bounds a log inherited from a dead worker and cannot bound one growing
 * right now — which is the only case that has ever filled a disk. The bound is therefore maintained in
 * process, on the append path, from a byte counter seeded with whatever was on disk at start.
 *
 * ## Why rotation must not log
 *
 * It is reached FROM the append path, so logging from it is mutual recursion. The old version could not have
 * been wired there for a second reason: its guard read `statSync(...)?.size <= MAX_LOG_BYTES`, and
 * `undefined <= n` is FALSE — so rotating when no log file exists fell THROUGH the guard to `renameSync`,
 * threw ENOENT, and logged that failure. On the append path, that is the original loop rebuilt by a
 * different door.
 */

import { appendFileSync, renameSync, statSync } from "node:fs";

/** One generation kept. Enough to read the death of the previous worker, not enough to fill a disk. */
export const MAX_LOG_BYTES = 16 * 1024 * 1024;

/**
 * Every side effect the writer has, in one object, so a test can watch all of them and inject no real fs.
 *
 * Each returns void deliberately. `process.stdout.write` answers a boolean about backpressure that nothing
 * here acts on, and letting it into the inferred type makes `typeof REAL_IO` demand that same boolean from
 * every fake -- a test double failing to typecheck over a value the writer never reads.
 *
 * @typedef {{ append: (path: string, text: string) => void,
 *             rename: (from: string, to: string) => void,
 *             size: (path: string) => number,
 *             writeConsole: (text: string) => void }} LogIO
 *
 * DECLARED, so the docstring above is enforced rather than merely asserted. It says each member returns
 * void deliberately, and until this file entered `tsc` nothing held it to that.
 *
 * @type {LogIO}
 */
const REAL_IO = {
  append: (path, text) => {
    appendFileSync(path, text, "utf8");
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  size: (path) => statSync(path, { throwIfNoEntry: false })?.size ?? 0,
  writeConsole: (text) => {
    process.stdout.write(text);
  },
};

/**
 * Stop a dead output stream from killing the process.
 *
 * Node reports a broken pipe either synchronously from `write()` or asynchronously as an `'error'` event, and
 * an unhandled `'error'` on a stream is escalated to `uncaughtException`. The writer below catches the
 * synchronous route; this closes the asynchronous one. Both are needed — the 354 GB log was produced by the
 * synchronous variant, and nothing about a given failure says in advance which route it will take.
 *
 * @param {import("node:stream").Writable} stream
 */
export function silenceStreamErrors(stream) {
  stream.on("error", () => {
    // Deliberately swallowed. There is nowhere to report the failure of the reporting channel itself, and
    // attempting to is precisely what looped.
  });
}

/**
 * @param {{ path: string, maxBytes?: number, io?: typeof REAL_IO }} options
 * @returns {(line: string) => void}
 */
export function createLogWriter({ path, maxBytes = MAX_LOG_BYTES, io = REAL_IO }) {
  // Seeded from what a previous worker left, then maintained here. Counted rather than stat()ed per line,
  // because logging is on the request path.
  let loggedBytes = io.size(path);

  /** @param {string} stamped */
  function writeToConsole(stamped) {
    try {
      io.writeConsole(stamped);
    } catch {
      // The file is the fallback here, exactly as the console is the file's fallback below.
    }
  }

  function rotate() {
    // Reset FIRST, so a rename that keeps failing is retried once per maxBytes rather than once per line.
    loggedBytes = 0;
    try {
      io.rename(path, `${path}.1`); // replaces any previous generation
    } catch (error) {
      // A worker that cannot rotate its log must still serve. Reported on the console only: the file is the
      // thing that is failing, and see the header for why this must never call the logger.
      writeToConsole(`could not rotate ${path}: ${/** @type {Error} */ (error).message}\n`);
    }
  }

  /** @param {string} stamped */
  function appendToFile(stamped) {
    try {
      // Checked BEFORE the append, so the first line after a rotation lands in the fresh file rather than in
      // the generation just retired — which is where a boot-time rotation used to put "listening on :8765".
      if (loggedBytes > maxBytes) rotate();
      io.append(path, stamped);
      loggedBytes += Buffer.byteLength(stamped, "utf8");
    } catch {
      // Console output is the fallback; a failed append must not take the worker down.
    }
  }

  return function log(line) {
    const stamped = `${line}\n`;
    writeToConsole(stamped);
    appendToFile(stamped);
  };
}
