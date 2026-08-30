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
 */
import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
 * @param {string} path
 * @param {{ stat?: (path: string) => { mtimeMs: number, size: number },
 *           read?: (script: string) => string,
 *           log?: (message: string) => void }} [injected]
 * @returns {string}
 */
export function fileProductVersion(path, { stat = statSync, read = powershellValue, log = defaultLog } = {}) {
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
  const value = read(`(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`);
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
