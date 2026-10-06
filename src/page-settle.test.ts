/**
 * A census that FAILED is not a reading of the page.
 *
 * `waitForPageToSettle` is the only non-speech wait in the capture path, and it exists because speech
 * settles just as happily on a shell as on a rendered page. Measured 2026-08-26 on the Met Office
 * warnings page: captured as `"blank"`, 27 announcements of navigation, a census of `heading=0` while
 * its published HTML carries FORTY headings — and two WCAG findings against a page with neither fault.
 *
 * The wait compared consecutive census shapes. `structuralCensus()` answers `{ error }` when CDP does not
 * reply, which is TRUTHY, so a guard testing only for a missing value let it through and reading four
 * absent counts off it produced the literal string `"undefined/undefined/undefined/undefined"`. Two
 * consecutive failures therefore compared EQUAL and the wait returned "settled" having learnt nothing,
 * putting back exactly the shell-capture it was written to prevent.
 *
 * Found by typechecking `capture-core.mjs`, not by a failing capture — the outcome of the bug is "we
 * stopped waiting", which looks like success from every angle this project measures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { censusShape } from "./capture-pure.mjs";

test("an errored census is not comparable, so two failures never agree", () => {
  assert.equal(censusShape({ error: "CDP /json/list returned HTTP 500" }), null,
    "an errored census must not be comparable, or two failures agree with each other");
  assert.equal(censusShape(null), null, "and a missing one is the same non-answer");
  assert.equal(censusShape(undefined), null);
});

test("THE CONTROL: a real census IS comparable, and a changing page reads as changing", () => {
  // Without this, every assertion above is satisfied by a function that returns null always — which
  // would make the settle wait run its full budget on every capture instead.
  assert.equal(censusShape({ heading: 3, link: 9, graphic: 1, landmark: 2 }), "3/9/1/2");
  assert.equal(censusShape({ heading: 3, link: 9, graphic: 1, landmark: 2 }),
    censusShape({ heading: 3, link: 9, graphic: 1, landmark: 2 }),
    "two identical readings must agree, or a settled page never settles");
  assert.notEqual(censusShape({ heading: 3, link: 9, graphic: 1, landmark: 2 }),
    censusShape({ heading: 4, link: 9, graphic: 1, landmark: 2 }),
    "a page still growing headings must read as still moving");
});

test("a page with genuinely nothing on it still counts as a reading", () => {
  // `1.3.1:no-headings` exists precisely to catch a page with no headings, and this repo's most expensive
  // rule is that a check must never reject evidence whose absence is the finding. An all-zero census is
  // an ANSWER — the page is settled and empty — and must not be confused with the error case above.
  assert.equal(censusShape({ heading: 0, link: 0, graphic: 0, landmark: 0 }), "0/0/0/0");
});
