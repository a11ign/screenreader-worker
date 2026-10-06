// @ts-check
// Which capture faults can the worker clear by itself, rather than failing the caller's case?
//
// Both faults below are the same underlying condition: a guest that has not finished settling, or an
// NVDA whose speech channel has died. capture-core already retries one of them for this reason --
// `startFreshWithRetry` retries `nvda.start`, reasoning that "one capture that takes eight seconds
// longer beats a run that loses its first case per worker".
//
// The MUTE case was left out of that bargain, so the first capture after a boot failed, and so did
// some proportion of the captures after it. The rate is stochastic and load-dependent: in a tight loop
// on a memory-pressured host, 5 of 30 captures went mute (lifespans 6, 5, 5, 9, 1), while across the
// corpus ~45% of NVDA instances survive all 25 reuses. Do not size anything on the 5-in-30 figure --
// it is the low tail. Confirmed causal either way: with `reuseScreenReader:false`, 8 of 8 ran clean.
// Before this retry existed, an identical 30-capture run died outright at capture 19.
//
// Why retrying here is not the loop that broke the pool: that loop restarted NVDA on a TIMER, while
// idle, with nothing wrong, at an unbounded rate, and NVDA answered by putting a modal dialog on the
// guest desktop. This restarts it at most ONCE, during a capture, only after that capture has already
// failed -- work the worker was going to do on the next request anyway. The only thing that changes is
// who pays for it.
//
// The hard timeout is deliberately absent. It has already spent its full budget, so retrying locally
// would double a request the caller has likely abandoned; the run classifies it transient and reissues
// it, which is the right place for a fault that expensive.
import { FAULT, faultCode } from "./capture-faults.mjs";

/** Faults a fresh screen reader fixes. Keyed on FAULT codes, never on message text — see capture-faults.mjs. */
const RECOVERABLE = new Set([FAULT.SCREEN_READER_MUTE, FAULT.SCREEN_READER_START_FAILED]);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isLocallyRecoverable(error) {
  // `faultCode` returns null for an error carrying none, and `Set.has(null)` is false — correct, but
  // saying so is clearer than relying on it, and it is what the types were objecting to.
  const code = faultCode(error);
  return code !== null && RECOVERABLE.has(code);
}
