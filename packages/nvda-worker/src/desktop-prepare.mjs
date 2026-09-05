// @ts-check
/**
 * Clearing the desktop before a capture — no guidepup, no NVDA, no browser.
 *
 * ## Why this file exists
 *
 * `@guidepup/guidepup` throws at import time where no screen reader exists, so merely importing
 * `server.mjs` — which imports `capture-core.mjs` for the real capture path — fails on Linux CI before a
 * single assertion runs. Invisible on macOS, because VoiceOver satisfies guidepup's availability check;
 * `capture-pure.mjs`'s own header records the same defect costing six test files once already. This is
 * that fix applied here: `prepareDesktop` and the two desktop caches are pure enough to live away from
 * guidepup entirely, so a test can import them directly and `tests-run-without-a-screen-reader.test.ts`
 * (which walks the whole import graph) has nothing to catch.
 *
 * `server.mjs` imports these and uses them exactly as before; every existing caller is unchanged.
 */
import { listBlockingDialogs, dismissBlockingDialogs, probeWindowOwner, foregroundBlocker }
  from "./desktop-dialogs.mjs";

/**
 * The last observed state of the desktop, sampled in the BACKGROUND.
 *
 * `/health` is polled by `worker-ctl.sh`, the pool lease and `doctor`, and it must never wait on a child
 * process — the first version of this called PowerShell from inside the readiness path and `/health` stopped
 * answering at all, which is the same defect `/diagnostics` has. So a timer samples, and the request only ever
 * reads memory. `dialogs: null` means "not sampled yet", which is deliberately NOT a failure: an unreadable
 * diagnostic must not take a worker offline, the rule `foregroundLockTimeout` already follows.
 */
// `dialogs: null` means NOT SAMPLED, and every reader below depends on that being distinct from an
// empty list -- `noBlockingDialog` answers null rather than true when nobody looked. Inferred from this
// literal the field is `null` forever, so the sample that fills it is the type error.
/** @type {{ at: number, dialogs: null | { handle: string, title: string, message: string, owner: string }[] }} */
export let dialogCache = { at: 0, dialogs: null };

/**
 * The foreground owner, sampled beside the dialogs and for the same reason one sample serves both.
 *
 * A MODAL is not the only thing that stops a capture. A notification toast holds the foreground without
 * being a dialog at all, so `listBlockingDialogs` returns nothing, `noBlockingDialog` stays true, and the
 * worker reports itself ready while Edge can never take focus. Measured on a11y-worker-6, 2026-09-02:
 * 3.5 hours of exactly that, with every readiness check green.
 *
 * `null` means NOT SAMPLED and never means fine — the same contract `dialogCache` carries.
 * @type {{ at: number, foreground: null | {title:string,owner:string,ok:boolean} }}
 */
export let foregroundCache = { at: 0, foreground: null };

/**
 * The two caches, for the one thing a test cannot otherwise see: whether an ABANDONED `prepareDesktop`
 * touched them. Real `/health` traffic never needs this -- `readiness()` reads the module bindings
 * directly -- so this exists purely to let a test assert "unchanged" without a second copy of the state.
 */
export function desktopCachesForTest() {
  return { dialogCache, foregroundCache };
}

/**
 * @param {{ listBlockingDialogs?: typeof listBlockingDialogs, probeWindowOwner?: typeof probeWindowOwner,
 *           log?: (message: string) => void }} [deps]
 */
export async function sampleDesktopDialogs(deps = {}) {
  const list = deps.listBlockingDialogs ?? listBlockingDialogs;
  const probe = deps.probeWindowOwner ?? probeWindowOwner;
  const log = deps.log ?? console.log;
  const dialogs = await list((reason) => log(`could not enumerate desktop dialogs: ${reason}`));
  dialogCache = { at: Date.now(), dialogs };
  if (dialogs.length) {
    log(`  desktop is blocked by ${dialogs.length} dialog(s): `
      + dialogs.map((d) => `${d.title}: ${d.message}`).join(" | "));
  }
  const foreground = await probe((reason) => log(`could not read the foreground window: ${reason}`));
  foregroundCache = { at: Date.now(), foreground };
  const blocker = foregroundBlocker(foreground);
  if (blocker) log(`  the foreground is held by ${blocker.owner} (${blocker.title}) — Edge cannot take focus`);
}

/**
 * Has `prepareDesktop` been ABANDONED by the time an await returned — and if so, say so and stop.
 *
 * `withTimeoutMs` (`server.mjs`) rejects the RACE at `DESKTOP_PREPARE_TIMEOUT_MS`, but the loser keeps
 * running: nothing in JS cancels an `await` chain because its caller stopped waiting on it. So a
 * `prepareDesktop` call that lost the race is still out there, mid-PowerShell-call, and when it eventually
 * resolves it was ABOUT to write `dialogCache`/`foregroundCache` — module globals `readiness()` reads for
 * every capture, not just this one — with a snapshot that is now stale by however long it overran, stamped
 * with a FRESH `Date.now()` as if it had just been sampled. A capture running RIGHT NOW would then have its
 * worker report readiness from a desktop state that describes a moment during a DIFFERENT capture's
 * preparation.
 *
 * Confirmed this cannot reach a capture RESULT: `dialogCache`/`foregroundCache` are read only inside
 * `readiness()` (`/health`), never merged into `marks`/`result.diagnostics`. So the fence below protects
 * `/health` from a confusing, stale-but-fresh-looking readiness signal — never a WCAG verdict.
 *
 * A FENCE, not real cancellation. Actually killing the PowerShell child changes the capture's own timing
 * and failure surface and wants a live capture to validate; checking a signal before each write is testable
 * offline and costs nothing on the path that matters, since `signal` is never aborted there.
 *
 * RECORDED, never silent — `refreshBrowseBuffer` was inert on every capture this project ever took, and
 * three green runs vouched for it anyway, because a remedy with no mark cannot be told apart from one that
 * never ran.
 *
 * @param {AbortSignal | undefined} signal
 * @param {Record<string, unknown>[]} marks
 * @param {string} after
 * @param {(message: string) => void} log
 */
function abandonedAfter(signal, marks, after, log) {
  if (!signal?.aborted) return false;
  log(`  desktop preparation was abandoned (its own timeout already fired) after ${after}; `
    + "dropping its write rather than applying stale state");
  marks.push({ event: "desktopPrepareAbandoned", atMs: 0, after });
  return true;
}

/**
 * Clear whatever is standing between this capture and the desktop, and record what was there.
 *
 * Extracted from `runCapture` when it crossed the physical-line budget, and it earns its own name rather
 * than merely shortening its caller: it does ONE thing at ONE level of abstraction -- make the desktop
 * usable, and say what was in the way. Two mechanisms, because a modal blocks INPUT and a foreground
 * holder blocks FOCUS, and a capture needs both cleared.
 *
 * A diagnostic mark carries whatever its EVENT needs beyond the two common fields — `desktopDialogsDismissed`
 * carries the dialogs, `foregroundBlocked` carries the owner and title — so the parameter is typed for the
 * shape they share rather than for one event's payload. Narrowing it to `{event, atMs}` made every mark
 * that says something a type error, which is the sink refusing the only thing it exists to carry.
 *
 * `signal` is checked after EACH await, before the write that await's result would otherwise feed — see
 * `abandonedAfter`. `deps` overrides the two PowerShell-calling functions and the logger for a test; real
 * callers get the real ones, so nothing about the deployed behaviour changes.
 *
 * @param {Record<string, unknown>[]} marks
 * @param {AbortSignal} [signal]
 * @param {{ dismissBlockingDialogs?: typeof dismissBlockingDialogs, probeWindowOwner?: typeof probeWindowOwner,
 *           log?: (message: string) => void }} [deps]
 */
export async function prepareDesktop(marks, signal, deps = {}) {
  const dismiss = deps.dismissBlockingDialogs ?? dismissBlockingDialogs;
  const probe = deps.probeWindowOwner ?? probeWindowOwner;
  const log = deps.log ?? console.log;
  const cleared = await dismiss((reason) => log(`could not dismiss desktop dialogs: ${reason}`));
  if (abandonedAfter(signal, marks, "dismissBlockingDialogs", log)) return;
  if (cleared.dismissed.length) {
    log(`  dismissed ${cleared.dismissed.length} blocking dialog(s) before capturing: `
      + cleared.dismissed.map((d) => `${d.title}: ${d.message}`).join(" | "));
    marks.push({ event: "desktopDialogsDismissed", atMs: 0, dialogs: cleared.dismissed });
  }
  // UNCONDITIONALLY, and that is the fix rather than a tidy-up.
  //
  // `sampleDesktopDialogs`'s own comment says "the sample that matters is the one at the START OF A
  // CAPTURE" -- and there was no such sample. The only call is at boot, and this cache was refreshed only
  // when something had been DISMISSED, so a guest that never had a dialog reported its boot-time answer
  // for as long as it stayed up. Measured on the fleet: workers up six days were serving
  // `dialogsCheckedMsAgo` of ~8,640 minutes, which is `/health` saying "no dialogs, as of last week".
  //
  // `dismissBlockingDialogs` has already enumerated by this point, so the current state is known for free:
  // whatever it found is now closed, and if it found nothing the desktop was clear anyway. Recording that
  // costs nothing and makes the comment true. "Dismissed none" and "never looked" were the same state,
  // which is this repo's oldest defect wearing a cache.
  dialogCache = { at: Date.now(), dialogs: [] };
  // And the foreground, which is the half no dialog check can see. One PowerShell call beside one that
  // already happens here, once per ~12 s capture -- paid at the only moment it answers a question, which
  // is the reasoning `sampleDesktopDialogs` gives for not putting it on a timer.
  const foreground = await probe((reason) => log(`could not read the foreground window: ${reason}`));
  if (abandonedAfter(signal, marks, "probeWindowOwner", log)) return;
  foregroundCache = { at: Date.now(), foreground };
  const holding = foregroundBlocker(foreground);
  if (holding) {
    log(`  the foreground is held by ${holding.owner} (${holding.title}) — Edge may not take focus`);
    marks.push({ event: "foregroundBlocked", atMs: 0, ...holding });
  }
}
