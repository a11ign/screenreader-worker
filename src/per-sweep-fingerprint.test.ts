/**
 * EVERY SWEEP FINGERPRINTS THE DOCUMENT IT IS ABOUT TO WALK — #758.
 *
 * Two fingerprints per capture bracket EIGHT sweeps, so a capture that navigates mid-run can be seen to
 * have moved and not to have moved anywhere in particular. Measured on calendly: `pageState(sweep)` said
 * `calendly.com/`, `pageState(focus)` said `accounts.google.com/v3/signin/identifier`, and six sweeps ran
 * between them with nothing saying which walked which page.
 *
 * READ FROM THE SOURCE — the `activation-gates.test.ts` exemption. This package imports guidepup and
 * throws at module load where no screen reader exists, so no test can call `collectByType`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8");

test("the fingerprint is taken inside collectByType, so ONE line covers every sweep", () => {
  // `sweepEveryStructuralType`, `sweepExtraTypes` and `rescanFormFieldsAfterSubmit` all reach the page
  // through `collectByType`. Marking at the call sites instead would be three places to forget — a remedy
  // applied at one call site when the behaviour reaches several is this repo's most expensive shape.
  const fn = SOURCE.slice(SOURCE.indexOf("async function collectByType"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /markPageState\(`sweep:\$\{ctx\.label\}`, ctx\.diag\)/,
    "collectByType must fingerprint the document before walking it");
  // BEFORE the walk, not after: a fingerprint taken afterwards describes wherever the sweep ended up,
  // which is the defect #699 fixed for the census one level up.
  assert.ok(body.indexOf("markPageState") < body.indexOf("sweepInDirection"),
    "the fingerprint must be taken BEFORE the sweep walks, or it describes where the sweep arrived");
});

test("the fingerprint records what it cost, so `cheap` is a number and not a claim", () => {
  // `markPageState`'s own header calls it cheap. #758 adds one per sweep, and `sweep` is already the
  // largest phase of a real page (#397) — so the cost of the instrument has to be checkable from a
  // capture rather than argued in a comment.
  const fn = SOURCE.slice(SOURCE.indexOf("async function markPageState"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /tookMs: Date\.now\(\) - startedAt/,
    "a fingerprint added per sweep must report its own cost");
});
