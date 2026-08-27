// @ts-check
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
  /**
   * The browser served its own error page instead of the site.
   *
   * NOT a screen-reader fault, and the distinction matters to what the host does next: retrying on a
   * fresh NVDA cannot help, because the URL is wrong or unreachable FROM THIS WORKER. Measured
   * 2026-08-25 in two different ways within one afternoon — no page server running, and a `localhost`
   * URL sent unchanged to a remote worker — both of which recorded Edge's "can't reach this page" as
   * evidence about the site.
   */
  PAGE_UNREACHABLE: "page-unreachable",
  /**
   * The browser is showing a DIFFERENT page from the one requested — reachable, just not this one.
   *
   * A separate code from PAGE_UNREACHABLE, and the split is not cosmetic. Both were reported as
   * `page-unreachable` until 2026-08-25, when five captures failed with it and the name sent the
   * diagnosis straight at the network: the page server was serving perfectly, and the `actual` URL in
   * every failure was a real page it was serving at that moment. "The address could not be reached" and
   * "the browser is on the wrong document" need opposite remedies, and this repo's most-named defect is
   * producing one answer where the other is true.
   *
   * NOT recoverable by a fresh NVDA — nothing about the screen reader is wrong — so it stays out of
   * `RECOVERABLE` for the same reason PAGE_UNREACHABLE does.
   */
  WRONG_PAGE: "wrong-page",
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
  // REFUSED rather than accepted, because the arguments are two strings and swapping them is silent.
  //
  // Two call sites had them the wrong way round — `captureFault(new Error("the browser is showing X, not
  // the page requested Y"), FAULT.WRONG_PAGE)` — so the rich diagnostic went into `.code` and the bare
  // code became the message. Measured 2026-08-26: seven real-page captures failed and the log read
  // `wrong-page` seven times, naming neither what was shown nor what was asked for, which is the whole
  // question. Worse, `faultCode()` then returned an Error OBJECT, so nothing keyed on fault codes —
  // `worker-recovery.mjs`, `capture-decisions.mjs` — could classify these two faults at all.
  //
  // This repo chose codes over message-matching precisely so recovery could not be broken by a reworded
  // string; a swap that turns the code into an object defeats that from the other end.
  if (!KNOWN_FAULTS.has(code)) {
    throw new TypeError(`captureFault(code, message): first argument must be a FAULT code, got `
      + `${typeof code === "object" ? "an Error — the arguments are swapped" : JSON.stringify(code)}`);
  }
  // Built with the property rather than assigned after, because `code` IS this helper's purpose — its
  // absence from the constructed type is what let the swapped-argument call typecheck for so long.
  return Object.assign(new Error(message, options), { code });
}

/** Every declared code, so an argument swap or a typo is refused at the throw site rather than shipped. */
const KNOWN_FAULTS = new Set(Object.values(FAULT));

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
