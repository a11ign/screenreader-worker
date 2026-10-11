/**
 * The Edge-updater guard's record, read for `/health` (#5021, part of #4405).
 *
 * WHY THE WORKER READS A FILE INSTEAD OF THE TASKS: it runs unelevated and cannot see Edge's update tasks --
 * `edgeUpdaterState` (`diagnostics.ts`) returned `tasks: []` on a guest carrying three disabled ones. The guard
 * task (`a11y-edge-updater-guard`, a11ign/control#52) runs as SYSTEM, re-disables whatever came back, and writes
 * `{checkedAt, reenabled}` to `C:\ProgramData\a11ign\edge-updater-guard.json`. That file is the one reading an
 * elevated process leaves where this one can open it, so this module turns it into a state a fleet can compare.
 *
 * GUIDEPUP-FREE on purpose, for the reason `file-version.ts` gives: `server.ts` cannot be imported off Windows,
 * and the thresholds below are exactly what a test has to reach.
 */
import { readFile } from "node:fs/promises";

export const GUARD_RECORD_PATH = "C:\\ProgramData\\a11ign\\edge-updater-guard.json";

/**
 * The guard runs every 15 minutes (`edge_guard_interval_minutes`), so three missed runs is a guard that has
 * stopped rather than one that is late: boot trigger lost, task disabled, or the box's clock wrong.
 */
export const GUARD_STALE_AFTER_MS = 45 * 60_000;

/**
 * A `checkedAt` AHEAD of this box's clock by more than this is a clock that moved (a snapshot restore, a VM
 * resume), not a guard that ran in the future. Inside the tolerance the record is read as "just now".
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/**
 * - `ok`      checked within `GUARD_STALE_AFTER_MS` and nothing had come back.
 * - `drift`   the last run found the updater re-enabled and put it down.
 * - `stale`   the last run is older than `GUARD_STALE_AFTER_MS`: the guard stopped, so its last word is history.
 * - `absent`  no record: a box not yet provisioned with the guard.
 * - `unknown` there is a record, or there may be, and it could not be read as one. NEVER `ok`.
 */
export type EdgeUpdaterGuardState = "ok" | "drift" | "stale" | "absent" | "unknown";

export type EdgeUpdaterGuard = { state: EdgeUpdaterGuardState; checkedAt: string | null; reenabled: string[] };

/** A FRESH object per call: this is served to a caller, and one shared literal is one `push` from lying for ever. */
export function unreadEdgeUpdaterGuard(state: "absent" | "unknown" = "unknown"): EdgeUpdaterGuard {
  return { state, checkedAt: null, reenabled: [] };
}

type GuardRecord = { checkedAt: string; checkedAtMs: number; reenabled: string[] };

/**
 * `null` is "this is not a record", which is a different claim from "the record says nothing came back": a
 * missing `reenabled` must not read as an empty one, or a half-written file reads as `ok`.
 */
function parseRecord(raw: string): GuardRecord | null {
  let json: unknown;
  try {
    // Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, and `JSON.parse` refuses it.
    json = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    // Not an error to rethrow: the caller turns `null` into the `unknown` state, which `/health` serves.
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const { checkedAt, reenabled } = json as Record<string, unknown>;
  const checkedAtMs = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
  // `ConvertTo-Json` in 5.1 can collapse a one-element list to a bare string; that loses nothing.
  const names = typeof reenabled === "string" ? [reenabled] : reenabled;
  if (Number.isNaN(checkedAtMs) || !Array.isArray(names) || !names.every((name) => typeof name === "string")) {
    return null;
  }
  return { checkedAt: checkedAt as string, checkedAtMs, reenabled: names };
}

/**
 * The state for a record's text at `nowMs`. Pure, and the one place the thresholds live.
 *
 * FRESHNESS IS ASKED BEFORE CONTENT: a stale record that names a re-enabled updater is `stale`, because the
 * run it describes is old and the guard's protection is what is missing now. `reenabled` is still carried, so
 * the history is not lost by being second.
 */
export function edgeUpdaterGuardFrom(raw: string, nowMs: number): EdgeUpdaterGuard {
  const record = parseRecord(raw);
  if (!record) return unreadEdgeUpdaterGuard("unknown");
  const { checkedAt, checkedAtMs, reenabled } = record;
  const ageMs = nowMs - checkedAtMs;
  const state = ageMs < -CLOCK_SKEW_TOLERANCE_MS ? "unknown"
    : ageMs > GUARD_STALE_AFTER_MS ? "stale"
    : reenabled.length > 0 ? "drift"
    : "ok";
  return { state, checkedAt, reenabled };
}

/**
 * Read the record NOW. Never rejects, and not memoised: the guard rewrites it every run, so a remembered
 * answer is exactly the stale one this field exists to expose.
 *
 * ENOENT is the only failure that is an ANSWER (`absent`). Access denied, a sharing violation, a path that is
 * not a file: those are "could not read", never `absent` and never `ok`.
 */
export async function readEdgeUpdaterGuard({ path = GUARD_RECORD_PATH, now = Date.now, read = readFile }: {
  path?: string;
  now?: () => number;
  read?: (path: string, encoding: "utf8") => Promise<string>;
} = {}): Promise<EdgeUpdaterGuard> {
  try {
    return edgeUpdaterGuardFrom(await read(path, "utf8"), now());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return unreadEdgeUpdaterGuard(code === "ENOENT" ? "absent" : "unknown");
  }
}
