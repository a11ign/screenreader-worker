// The faults a capture can end with, as CODES rather than as prose to be pattern-matched.
//
// Recovery used to be decided by running a regex over `error.message` -- on the guest in
// worker-recovery.mjs, and on the host in capture-decisions.mjs. That couples behaviour to wording:
// rewording the mute error silently disables the retry, and because the unit tests hardcode the old
// wording they keep passing while production quietly stops recovering. A check that cannot
// discriminate is this project's recurring defect, and that was one of them.
//
// Two references say the same thing. *Secure by Design* (9.2.2, "Designing for failures") argues that
// failures which are expected in the domain should be modelled as explicit results rather than
// exceptions, so callers can inspect the failure TYPE. *The Product-Minded Engineer* ("Repackage
// Errors") is more direct: make runtime errors programmable by using specific error types and
// attaching structured metadata "rather than forcing callers to parse messages".
//
// A mute screen reader is not exceptional here -- it recurs often enough across a run that the corpus
// shows ~55% of NVDA instances dying before their 25-capture recycle -- so it is exactly the "expected
// domain failure" both books describe, rather than something to model as an exception.
export const FAULT = {
  /** NVDA is running and answering keystrokes, but has stopped speaking. Clears on a fresh NVDA. */
  SCREEN_READER_MUTE: "screen-reader-mute",
  /** NVDA would not start. Usually a guest still settling after auto-logon. */
  SCREEN_READER_START_FAILED: "screen-reader-start-failed",
};

/**
 * An Error carrying a fault code, without losing the message or the cause.
 *
 * The message stays human-readable because it is what lands in the run's failure list and in
 * server.log; the code is what behaviour keys on. Both, not either.
 *
 * @param {string} code one of FAULT
 * @param {string} message
 * @param {{ cause?: unknown }} [options]
 * @returns {Error & { code: string }}
 */
export function captureFault(code, message, options) {
  const fault = new Error(message, options);
  fault.code = code;
  return fault;
}

/**
 * The fault code on an error, or null if it carries none.
 *
 * @param {unknown} error
 * @returns {string | null}
 */
export function faultCode(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  return typeof code === "string" ? code : null;
}
