// @ts-check
/**
 * The readable text of something thrown, whatever it was.
 *
 * JavaScript can throw ANY value — a string, an object, undefined — so a caught value is `unknown` and
 * reading `.message` off it is a guess. When the guess is wrong the result is `undefined`, and a
 * diagnostic that says `undefined` is worse than one that says nothing: it looks like an answer.
 *
 * That is not theoretical here. This repo's whole diagnostics model exists because silent catches hid an
 * outage, and its worst recurring shape is a message that cannot say what it caught — a fetch that failed
 * and reported success, a guard that crashed writing its own explanation, seven capture failures logging
 * a bare fault code. Narrowing before reading is the cheapest possible guard against another.
 *
 * `capture-core.mjs` had this as a private one-liner with 35 call sites and nothing else could use it, so
 * every other module reached into a caught value directly. One definition now, reachable by subpath so a
 * caller does not pull the worker's root — and therefore guidepup — into a portable module.
 */

/**
 * @param {unknown} thrown
 * @returns {string}
 */
export function errorText(thrown) {
  if (thrown instanceof Error) return thrown.message;
  // Not an Error, but object-shaped with a message: node and several libraries throw these.
  if (thrown && typeof thrown === "object" && "message" in thrown) {
    return String(/** @type {{message: unknown}} */ (thrown).message);
  }
  return String(thrown);
}

/**
 * A thrown value's `code`, when it carries one, else null.
 *
 * Node attaches `code` to system errors (`ENOENT`, `ECONNRESET`) and this repo attaches its own fault
 * codes. Matching on a CODE rather than on message text is the rule `capture-faults.mjs` was written to
 * enforce; this is the same idea for the errors it did not raise.
 *
 * @param {unknown} thrown
 * @returns {string|null}
 */
export function errorCode(thrown) {
  if (thrown && typeof thrown === "object" && "code" in thrown) {
    const code = /** @type {{code: unknown}} */ (thrown).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}
