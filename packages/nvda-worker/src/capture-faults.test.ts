/**
 * A fault must carry a classifiable CODE and a message that says what happened.
 *
 * `capture-faults.mjs` exists because recovery keyed on `error.message` could not discriminate — reword a
 * message and recovery stops working in production while the unit tests keep passing, because the string
 * they assert on lives in the test file rather than at the throw site. Codes fixed that.
 *
 * These pin the other end of it: a code that is not a code, and a message that is really a code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "@a11y-witness/evidence/source-text";
import { captureFault, faultCode, FAULT } from "./capture-faults.mjs";


test("a swapped code/message is refused at the throw site", () => {
  // Two call sites had them the wrong way round for as long as those faults have existed. The rich
  // diagnostic went into `.code` and the bare code became the message, so seven real-page failures logged
  // `wrong-page` seven times — naming neither what was shown nor what was asked for, which is the whole
  // question the fault exists to answer.
  //
  // The second consequence is worse and was silent: `faultCode()` returned an Error OBJECT, so nothing
  // keyed on codes — `worker-recovery.mjs`, `capture-decisions.mjs` — could classify these two faults.
  // This repo chose codes over message-matching so recovery could not be broken by a reworded string; a
  // swap that turns the code into an object defeats that from the other end.
  // Cast because the JSDoc types DO declare (code: string, message: string) — TypeScript rejects this
  // call outright. That is the finding, not a nuisance: the types knew, and could not help, because
  // `capture-core.mjs` is .mjs and nothing typechecks it. The runtime guard is what covers that gap.
  assert.throws(() => captureFault(new Error("the browser is showing X") as never, FAULT.WRONG_PAGE),
    /arguments are swapped/, "an Error as the first argument is always the swap");
  assert.throws(() => captureFault("not-a-declared-fault", "message"),
    /must be a FAULT code/, "a typo'd code must not ship either");
});

test("the message survives and the code is classifiable", () => {
  const fault = captureFault(FAULT.WRONG_PAGE, 'the browser is showing "a", not "b"');
  assert.match(fault.message, /the browser is showing/, "the diagnostic is the message, not the code");
  assert.equal(faultCode(fault), FAULT.WRONG_PAGE, "and the code is a STRING recovery can match on");
});

test("every captureFault call site passes the code first", () => {
  // The guard above catches it at runtime, on a Windows worker, mid-capture. This catches it here.
  // `capture-setup.mjs`, not `capture-core.mjs`: every captureFault call site lives there since the
  // 2026-09-05 split (neither `capture-core.mjs` nor `capture-probes.mjs` imports FAULT/captureFault).
  const source = readFileSync(new URL("./capture-setup.mjs", import.meta.url), "utf8");
  const swapped = [...source.matchAll(/captureFault\(\s*new Error/g)];
  assert.equal(swapped.length, 0,
    "captureFault takes (code, message) — an Error in the first position is the swap that made seven "
    + "failures log a bare `wrong-page` and made their codes unclassifiable");
});

test("the settle wait is a CONDITION, not a duration, and cannot hang on an empty page", () => {
  // The URL guard proves the browser shows the right address; it says nothing about whether that document
  // has RENDERED. For a client-rendered page the address is correct immediately while the DOM is a shell,
  // and every other wait in capture-core is speech-based — speech settles just as happily on a shell.
  // Measured: the Met Office warnings page captured as "blank", 27 announcements, census heading=0, while
  // its published HTML carries forty headings. Two WCAG findings against faults the page does not have.
  // Comments stripped before matching -- unbounded to end of file, and this file discusses
  // headings/census logic extensively in prose elsewhere, so a bare regex here risks matching a LATER,
  // unrelated comment rather than this function's own code. See `@a11y-witness/evidence/source-text`.
  // `waitForPageToSettle` lives in `capture-setup.mjs` since the 2026-09-05 split.
  const source = stripComments(readFileSync(new URL("./capture-setup.mjs", import.meta.url), "utf8"));
  const settle = source.slice(source.indexOf("async function waitForPageToSettle"));
  assert.match(settle, /shape === previous/,
    "it must wait for the tree to STOP CHANGING — waiting for content would hang the whole budget on a "
    + "page that genuinely has no headings, which is precisely what 1.3.1:no-headings exists to catch");
  assert.ok(!/heading\s*>\s*0|heading\s*!==\s*0/.test(settle),
    "a content test here would reject evidence whose absence is the finding");
  assert.match(settle, /diag\.mark\("pageSettled"/,
    "marked whether or not it waited: `settled immediately` and `never ran` must never be one silence");
  // Both exits mark, so an unsettled page is DESCRIBED rather than refused — a ticker or a live feed
  // never settles, and failing it would reject evidence rather than record it.
  assert.equal(settle.match(/diag\.mark\("pageSettled"/g)?.length, 2,
    "both the settled and the timed-out path must record what happened");
});
