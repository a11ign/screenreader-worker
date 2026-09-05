/**
 * THE WORKER'S CONTAINER STRIP MUST KNOW EVERY CONTAINER THE GRAMMAR KNOWS.
 *
 * "What a container prefix looks like" exists in FOUR places and none can be deleted:
 *
 *   `CONTAINER_ROLES`   announcement.ts            the grammar, TypeScript, read by the judge
 *   `CONTAINER_PREFIX`  capture-pure.mjs           the worker, plain Node, runs on Windows
 *   `CONTAINER_PREFIX`  screenreader_features.py   the featurizer, Python, runs in the lab
 *   the 2.4.3 counter   rules.ts                   a narrower question, deliberately its own
 *
 * On 2026-09-05 `w3c/html-aria#423` moved all four at once: it made the `form` role conditional on an
 * accessible name, so Edge 152 announces an unnamed `<form>` as "section". Every corpus form is unnamed.
 * Each copy had to be found and fixed separately, and the Python one's comment ALREADY recorded them
 * drifting — "one fact in two languages, and the copies drifted" — while counting two of the four.
 *
 * `test_heading_name_strips_containers.py` asserts the right PROPERTY and could not have caught this: it
 * reads REAL CORPUS ANNOUNCEMENTS, so a new container word is only covered once a capture happens to
 * contain one. That is coverage arriving after the damage. This asserts the same property against the
 * grammar's own vocabulary, so a word added to `CONTAINER_ROLES` is covered the day it is added.
 *
 * Both sides are IMPORTED, never scraped. A test that reads its expectations out of source text is this
 * repo's own anti-pattern, and it would also become a fifth copy of the fact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTAINER_ROLES } from "@a11y-witness/evidence";
import { CONTAINER_PREFIX } from "./capture-pure.mjs";

/**
 * Container roles the GRAMMAR parses and the WORKER deliberately does not strip.
 *
 * This started as an assertion that the two agree, and the assertion FAILED on eight roles. That is not
 * automatically eight defects, and applying the widening blind would have been the wrong move: the worker's
 * pattern feeds `dedupeKey`, and the last change to it was "VERIFIED BEFORE APPLYING: over all 24,774 sweep
 * announcements the repeated strip changes 146 keys and reduces NONE to empty — the over-strip signature
 * this would otherwise risk". Stripping "list, " from a key could collapse two genuinely different
 * announcements into one, which loses evidence rather than cleaning it.
 *
 * THEY WERE A LEDGER WITH AN OPEN QUESTION. IT IS NOW ANSWERED, AND THE ANSWER IS NO — measured
 * 2026-09-05 by running the widened pattern over 19,297 sweep announcements from 2,178 corpus captures,
 * which is the check quoted above:
 *
 *     keys the wider strip would change      2,583
 *     reduced to EMPTY (the over-strip risk)     0
 *     distinct keys COLLAPSED                    0   <- the entire point of dedupe
 *
 * It changes 2,583 keys and merges NOTHING. That is pure churn, and the examples show it is worse than
 * churn: `"list, with 6 items, Opening times…"` becomes `"with 6 items, Opening times…"` — the container
 * WORD stripped and its item count left behind as a fragment. `announcement.ts` records the cause beside
 * its own list: "the item count sits on EITHER side of the comma depending on the container".
 *
 * So these eight stay off the worker's pattern DELIBERATELY. What would change the answer is a container
 * announced as a bare `"<role>, "` with nothing between it and the name — the shape `form` and `section`
 * have, and none of the eight does.
 *
 * `section` is NOT here, and that is the point of the file: it was added the day Edge 152 introduced it.
 */
const GRAMMAR_ONLY_CONTAINERS = new Set([
  "frame", "grouping", "group", "dialog", "menu", "list", "table", "blockquote",
]);

test("no container role joins the grammar without someone deciding what the worker does with it", () => {
  const singleWords = CONTAINER_ROLES.filter((role) => !role.includes(" "));
  assert.ok(singleWords.length > 5, "the grammar's container list has changed shape; re-read this test");

  const missed = singleWords.filter((role) =>
    `${role}, Full name, edit`.replace(CONTAINER_PREFIX, "") !== "Full name, edit");

  const surprises = missed.filter((role) => !GRAMMAR_ONLY_CONTAINERS.has(role));
  assert.deepEqual(surprises, [],
    `these container roles are in the grammar and are NOT stripped by the worker, so the prefix survives `
    + `into a swept announcement and becomes part of the control's NAME: ${surprises.join(", ")}. `
    + `Add them to CONTAINER_PREFIX in capture-pure.mjs AND to the Python copy in `
    + `screenreader_features.py — or to GRAMMAR_ONLY_CONTAINERS above, with the reason.`);

  // BOTH DIRECTIONS. A ledger entry that is no longer true is a phantom, and a ledger nobody prunes stops
  // describing anything — the reasoning `evidence-fields.test.ts` gives for the same shape.
  const stale = [...GRAMMAR_ONLY_CONTAINERS].filter((role) => !missed.includes(role)).sort();
  assert.deepEqual(stale, [],
    `these are now stripped by the worker and should come off the ledger: ${stale.join(", ")}`);
});

test("the word Edge 152 introduced is handled, and so is the one it replaced", () => {
  // Both, explicitly, because 3,246 captures on disk carry "form, ..." and a worker that only understands
  // the current browser cannot re-read its own corpus.
  for (const role of ["form", "section"]) {
    assert.equal(`${role}, Full name, edit`.replace(CONTAINER_PREFIX, ""), "Full name, edit",
      `"${role}, " must be stripped: it is what an unnamed <form> announces as, before and after `
      + `w3c/html-aria#423`);
  }
});
