// @ts-check
/**
 * The desktop's display mode and graphics adapter, sampled on a TIMER and only ever READ by a request (#2673).
 *
 * ## Why this file exists
 *
 * `/health` is polled and its own comment says "nothing here may walk a disk or shell out". The environment
 * block it serves rebuilt behind a 5 s cache, and the rebuild ran two SYNCHRONOUS `powershell.exe` calls
 * (`displayMode` and `displayAdapter`). `execFileSync` blocks Node's event loop for the whole call, so the
 * first `/health` after 5 s of quiet cost 0.53 to 0.76 s on twelve workers and 2.8 to 3.1 s on three, and
 * for that long the worker answered NOTHING on any route (read on the fleet by `orchestrator`, #2671; a
 * request every 2 s on a11y-worker-13 read `2.95 0.003 0.003 2.88 0.004 0.004 2.88`).
 *
 * Both facts DO change under a running worker (a provisioning run sets the mode, a driver install changes
 * the adapter) and noticing that is the point of reporting them, so they are not memoised at boot. They are
 * sampled the way `desktop-dialogs.mjs` samples dialogs: off the request path, into memory. And the sample
 * shells out ASYNCHRONOUSLY, so even the timer's own PowerShell time does not stop the loop -- moving a
 * blocking call from a request to a timer would have kept the stall and only changed who paid for it.
 *
 * ## A sample says how old it is
 *
 * `displaySampledMsAgo` is computed at READ time, the lesson of `dialogsCheckedMsAgo` (`desktop-prepare.mjs`):
 * a cache that answers without its age reads as a fresh measurement, which is what `/health` said about
 * dialogs for six days. `null` is "never sampled yet" and is not a failure, and it is kept distinct from a
 * sample that read "unknown".
 *
 * No guidepup here, so a Linux test can import it (`desktop-prepare.mjs`'s header records the cost of the
 * alternative).
 */

/** How long after one sample FINISHES the next one starts. The 5 s the environment cache always used. */
export const DISPLAY_SAMPLE_MS = 5_000;

/**
 * @typedef {{ displayMode: string, displayAdapter: string, displaySampledMsAgo: number | null }} DisplayReading
 */

/**
 * @param {{ readMode: () => Promise<string>, readAdapter: () => Promise<string>,
 *           now?: () => number, tickMs?: number }} deps
 *   The two readers are ASYNC and answer `"unknown"` rather than throwing, as `displayMode` and
 *   `displayAdapter` always did; a throw here is still contained, so a tick can never take the worker down.
 * @returns {{ current: () => DisplayReading, refresh: () => Promise<void>, start: () => void, stop: () => void }}
 */
export function createDisplaySampler({ readMode, readAdapter, now = Date.now, tickMs = DISPLAY_SAMPLE_MS }) {
  // "unknown" and not absent, for the reason `displayMode` gives: `fleetConsistency` skips an absent value,
  // so a guest nobody has read yet would rejoin the "nobody disagrees" population. Its `null` age is what
  // says "never looked".
  let mode = "unknown";
  let adapter = "unknown";
  /** @type {number | null} */
  let sampledAt = null;
  /** @type {Promise<void> | null} */
  let running = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let stopped = true;

  async function sampleOnce() {
    // Concurrently, and each one contained: one reader failing must not discard the other's answer.
    const [nextMode, nextAdapter] = await Promise.all([
      readMode().catch(() => "unknown"),
      readAdapter().catch(() => "unknown"),
    ]);
    mode = nextMode;
    adapter = nextAdapter;
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
    /** Memory only. This is what a request calls, and it must stay that. */
    current: () => ({
      displayMode: mode,
      displayAdapter: adapter,
      displaySampledMsAgo: sampledAt === null ? null : now() - sampledAt,
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
