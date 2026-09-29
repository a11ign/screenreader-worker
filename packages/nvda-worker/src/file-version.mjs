// @ts-check
/**
 * An executable's product version, memoised on the FILE rather than on process lifetime.
 *
 * MOVED OUT OF `server.mjs` on 2026-08-30, verbatim. `server.mjs` imports `capture-core.mjs`, which
 * imports guidepup, which constructs a ScreenReader at MODULE SCOPE and throws where none exists — so
 * `file-version-memo.test.ts` could not import this function on a Linux runner, even though the function
 * itself touches nothing but `fs` and PowerShell and is injectable precisely so it can be tested off
 * Windows. known-gaps §12, second occurrence.
 *
 * `server.mjs` imports and re-exports both of these, so its callers are unchanged.
 *
 * `fileProductVersion` is ASYNC (#2684): its `read` used to be `execFileSync`, called straight from
 * `/health`'s 5 s rebuild whenever a version had not yet been memoised -- a transient PowerShell failure,
 * or a binary that had just changed on disk, so the same call site re-shelled out on every rebuild until
 * one succeeded. That is `server.mjs`'s own `bootConstant` stall (#2673) again, for these two fields.
 * `createVersionSampler` (below) now calls this on a TIMER, never from a request, and awaiting an async
 * child process off the request path costs nothing a request pays for. `powershellValue` (sync) stays,
 * unchanged, for `foregroundLockTimeout`, which reads exactly once, ever, and is not this row's subject.
 *
 * `createVersionSampler` lives here rather than in `server.mjs`, for the reason this whole file was moved
 * out on 2026-08-30: `server.mjs` needs guidepup and cannot be imported off Windows, so a test proving the
 * sampler's BEHAVIOUR (never blocks, retries only what failed, ages its reading) has to reach it from a
 * module that does not. `display-sample.mjs` is the display's version of the same seam.
 */
import { statSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POWERSHELL_VALUE_TIMEOUT_MS = 5_000;

export function powershellValue(/** @type {any} */ script) {
  if (process.platform !== "win32") return "unknown";
  try {
    const value = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: POWERSHELL_VALUE_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
    return value || "unknown";
  } catch {
    // "unknown" rather than throwing: a version string we could not read must never take a worker offline.
    return "unknown";
  }
}

/**
 * `powershellValue`'s asynchronous twin: the same command, the same bound, the same "unknown" degrade --
 * but `execFile` rather than `execFileSync`, so a caller on a timer never blocks the event loop for the
 * call's whole duration. `fileProductVersion` defaults to this rather than to `powershellValue`, because
 * the only remaining caller of `fileProductVersion` is a background sampler, never a request.
 */
export async function powershellValueAsync(/** @type {any} */ script) {
  if (process.platform !== "win32") return "unknown";
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], { encoding: "utf8", timeout: POWERSHELL_VALUE_TIMEOUT_MS, windowsHide: true });
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Where the version-changed warning goes when the caller does not say.
 *
 * `server.mjs` owns the real log writer and passes it in; this default exists so the warning is never
 * silently dropped by a caller that forgot. A no-op default would lose exactly the message this function
 * was written to emit — Edge updating under a running worker, which stamped five days of captures with a
 * build they were not taken under.
 */
const defaultLog = (/** @type {string} */ message) => process.stderr.write(`${message}\n`);

const fileVersions = new Map();

/**
 * `stat` and `read` are injectable so this is testable off Windows, where `powershellValue` cannot run.
 * The defect it fixes was invisible to every check precisely because nothing could exercise it, and a
 * deploy would have HIDDEN it -- restarting the worker rebuilds the memo, so a correct version after a
 * deploy proves the restart worked and says nothing about the invalidation.
 *
 * The injected types name only the FIELDS this function reads, rather than `typeof statSync` -- same
 * reasoning as `ScorableCapture` in evidence-units.ts. A narrow contract is what makes the seam usable from
 * a test, and it says in the type system that nothing here depends on the rest of `Stats`.
 *
 * ASYNC (#2684), and `read` defaults to `powershellValueAsync` rather than `powershellValue`: the only
 * remaining caller is `server.mjs`'s version sampler, on a timer, never a request. `stat` stays
 * SYNCHRONOUS -- it is one syscall, not a shelled-out child process, and the sampler needs the file's
 * CURRENT identity to know whether a read is even owed before it pays for one.
 *
 * @param {string} path
 * @param {{ stat?: (path: string) => { mtimeMs: number, size: number },
 *           read?: (script: string) => Promise<string>,
 *           log?: (message: string) => void }} [injected]
 * @returns {Promise<string>}
 */
export async function fileProductVersion(path, { stat = statSync, read = powershellValueAsync, log = defaultLog } = {}) {
  let identity;
  try {
    const info = stat(path);
    identity = `${path}|${info.mtimeMs}|${info.size}`;
  } catch {
    // Vanished or unreadable. Not memoisable, and "unknown" is the honest answer -- the same rule
    // `bootConstant` applies to a failed read.
    return "unknown";
  }
  if (fileVersions.has(identity)) return fileVersions.get(identity);
  const escaped = path.replace(/'/g, "''");
  const value = await read(`(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`);
  if (value === "unknown") return value; // a transient PowerShell failure must not become permanent
  const previous = [...fileVersions.entries()].find(([key]) => key.startsWith(`${path}|`));
  if (previous && previous[1] !== value) {
    log(`${path} changed version under a running worker: ${previous[1]} -> ${value}. `
      + "Captures before and after this point have different cache keys and are not interchangeable.");
    fileVersions.delete(previous[0]);
  }
  fileVersions.set(identity, value);
  return value;
}

/** How long after one sample FINISHES the next one starts. The 5 s the environment cache always used. */
export const VERSION_SAMPLE_MS = 5_000;

/**
 * @typedef {{ windowsVersion: string, screenReaderVersion: string, browserVersion: string,
 *             versionsSampledMsAgo: number | null }} VersionReading
 */

/**
 * `windowsVersion`, `screenReaderVersion` and `browserVersion`, sampled on a TIMER and only ever READ by a
 * request (#2684) -- the `display-sample.mjs` shape (#2673), for the same reason: `/health` is polled, and
 * rebuilding these three on its 5 s cache used to call `bootConstant`/`fileProductVersion` synchronously,
 * so a version that had not yet been read, or a binary that had changed on disk, re-ran `powershell.exe`
 * on the request path every 5 s.
 *
 * GENERIC over its three readers, on purpose: this file already keeps the file-identity memo and the
 * change-detection logging (`fileProductVersion`, above), and `server.mjs` keeps `windowsVersion`'s memo
 * (`bootConstants`) -- the sampler's only job is to call each reader on a timer and remember the last
 * answer, exactly as `createDisplaySampler` does for two fields instead of three.
 *
 * @param {{ readWindowsVersion: () => Promise<string>, readScreenReaderVersion: () => Promise<string>,
 *           readBrowserVersion: () => Promise<string>, now?: () => number, tickMs?: number }} deps
 *   Each reader is ASYNC and answers `"unknown"` rather than throwing, as `bootConstant` and
 *   `fileProductVersion` always did; a throw here is still contained, so a tick can never take the worker
 *   down.
 * @returns {{ current: () => VersionReading, refresh: () => Promise<void>, start: () => void, stop: () => void }}
 */
export function createVersionSampler({ readWindowsVersion, readScreenReaderVersion, readBrowserVersion,
  now = Date.now, tickMs = VERSION_SAMPLE_MS }) {
  let windowsVersion = "unknown";
  let screenReaderVersion = "unknown";
  let browserVersion = "unknown";
  /** @type {number | null} */
  let sampledAt = null;
  /** @type {Promise<void> | null} */
  let running = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let stopped = true;

  async function sampleOnce() {
    // Concurrently, and each one contained: one reader failing must not discard the other two's answers.
    const [nextWindows, nextScreenReader, nextBrowser] = await Promise.all([
      readWindowsVersion().catch(() => "unknown"),
      readScreenReaderVersion().catch(() => "unknown"),
      readBrowserVersion().catch(() => "unknown"),
    ]);
    windowsVersion = nextWindows;
    screenReaderVersion = nextScreenReader;
    browserVersion = nextBrowser;
    sampledAt = now();
  }

  /** Never two samples at once: a slow guest must not stack PowerShell children. */
  function refresh() {
    running ??= sampleOnce().finally(() => { running = null; });
    return running;
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(() => { void refresh().then(scheduleNext); }, tickMs);
    // A process holding nothing else must still be able to exit, as `startForegroundWatch`'s timer does.
    timer.unref?.();
  }

  return {
    /**
     * Memory only. This is what a request calls, and it must stay that. Spelled out rather than shorthand
     * -- `fleet-consistency.test.ts` finds these fields by scanning this literal source for `fieldName:`,
     * the same device `display-sample.mjs`'s `current()` uses, and a shorthand collapse would blind it.
     */
    current: () => ({
      windowsVersion: windowsVersion,
      screenReaderVersion: screenReaderVersion,
      browserVersion: browserVersion,
      versionsSampledMsAgo: sampledAt === null ? null : now() - sampledAt,
    }),
    refresh,
    start() {
      if (!stopped) return;
      stopped = false;
      void refresh().then(scheduleNext);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
