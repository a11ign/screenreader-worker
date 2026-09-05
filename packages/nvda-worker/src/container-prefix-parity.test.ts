/**
 * THE WORKER'S CONTAINER STRIP MUST KNOW EVERY CONTAINER THE GRAMMAR KNOWS.
 *
 * "What a container prefix looks like" exists in THREE places today, not four:
 *
 *   `CONTAINER_ROLES`   announcement.ts            the grammar, TypeScript, read by the judge
 *   `CONTAINER_PREFIX`  capture-pure.mjs           the worker, plain Node, runs on Windows
 *   `CONTAINER_PREFIX`  screenreader_features.py   the featurizer, Python, runs in the lab
 *
 * A fourth used to be here — "the 2.4.3 counter" in `rules.ts` — and this docstring named it as a
 * still-living, narrower copy through 2026-09-05. It is gone: `rules.ts` deleted its own container/landmark
 * stripping outright (see the block above `addKeyboardUnreachableControl` headed "FOUR grammar fragments
 * lived here") and now delegates entirely to `parseAnnouncement` in `announcement.ts`. A stale claim
 * sitting in a test's own docstring is this file's namesake defect one level up: found only by reading the
 * code the docstring described rather than the docstring itself.
 *
 * On 2026-09-05 `w3c/html-aria#423` moved the (then-)four at once: it made the `form` role conditional on
 * an accessible name, so Edge 152 announces an unnamed `<form>` as "section". Every corpus form is unnamed.
 * Each copy had to be found and fixed separately, and the Python one's comment ALREADY recorded them
 * drifting — "one fact in two languages, and the copies drifted" — while counting two of the four.
 *
 * `test_heading_name_strips_containers.py` asserts the right PROPERTY and could not have caught this: it
 * reads REAL CORPUS ANNOUNCEMENTS, so a new container word is only covered once a capture happens to
 * contain one. That is coverage arriving after the damage. This asserts the same property against the
 * grammar's own vocabulary, so a word added to `CONTAINER_ROLES` is covered the day it is added.
 *
 * BOTH TS/JS SIDES ARE IMPORTED, never scraped. A test that reads its expectations out of source text is
 * this repo's own anti-pattern, and it would also become a fifth copy of the fact. The Python side is the
 * documented exception: `screenreader_features.py` cannot be imported into a JS test at all, so its
 * accepted-word set is read from its own source text below — the same technique, and the same reasoning,
 * as `forbidden-input-keys-parity.test.ts`.
 *
 * THIS FILE USED TO PIN ONLY TWO OF THE THREE REMAINING COPIES — TS's grammar against the JS worker's own
 * regex, leaving the Python copy uncompared by anything. Audited 2026-09-05 and found to genuinely differ:
 * Python's `CONTAINER_PREFIX` additionally treats bare `"search,"` and `"contentinfo,"` as strippable
 * container prefixes — neither TS's `CONTAINER_ROLES` nor the JS worker's `CONTAINER_PREFIX` recognises
 * either word outside the compound "`X` landmark" form. See `KNOWN_PYTHON_ONLY_WORDS` below: this is now a
 * pinned, dated divergence rather than an unpinned one. Left AS MEASURED rather than reconciled — collapsing
 * it means editing the feature-extraction regex, which bumps `FEATURE_SCHEMA_VERSION` and needs a retrain to
 * validate, not a change to make beside an unrelated audit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/**
 * THE PYTHON COPY, PINNED AS A KNOWN, DATED DIVERGENCE — NOT AS EQUALITY.
 *
 * Measured 2026-09-05: `screenreader_features.py`'s `CONTAINER_PREFIX` accepts two bare words the JS
 * worker's does not, `"search,"` and `"contentinfo,"`. Both come from `LANDMARK_ROLES`, a Python-only set
 * that also feeds a DIFFERENT purpose (a landmark-vs-not classification) and was folded into the prefix
 * regex's alternation wholesale rather than word by word — so these two travelled in without a specific
 * decision the way `"section"` got one.
 *
 * Checked against the local `runs/` snapshot on disk (2,181 dataset captures + 28 real-page captures,
 * dated 2 Sep): no capture contains a bare `"search,"` or `"contentinfo,"` — every real occurrence reads
 * `"search landmark, ..."`, which both sides already strip (via the generic leading-name mechanism on the
 * JS side, and via the `(?:\s+landmark)?` suffix on the Python side). That snapshot is a known-stale copy,
 * not the authoritative corpus, so "unobserved" here is SUSPECTED rather than SETTLED — record it as such,
 * do not read it as proof the divergence is safe.
 *
 * NOT RECONCILED, deliberately: `structured_feature_values` reads through this regex, so narrowing it is a
 * feature-extraction change and would need `FEATURE_SCHEMA_VERSION` bumped and a retrain to validate —
 * fleet/lab work, out of reach here and not a thing to fold into an unrelated audit regardless.
 *
 * BOTH SIDES READ FROM THE REAL ARTEFACT, never restated: the JS set comes off the imported `CONTAINER_
 * PREFIX` regex's own `.source`, and the Python set off `screenreader_features.py`'s source text (which
 * cannot be imported into a JS test at all) — the same exception `forbidden-input-keys-parity.test.ts`
 * documents and takes.
 */
const KNOWN_PYTHON_ONLY_WORDS = new Set(["search", "contentinfo"]);

function jsAcceptedBareWords(): string[] {
  // The role alternation is the LAST parenthesised group before the trailing `,\s*` — the leading
  // `(?:\w[\w\s'-]*[,\s]\s*)?` group is the optional preceding NAME, not a role.
  const match = /\(\?:([a-z|\s]+)\),\\s\*$/i.exec(CONTAINER_PREFIX.source);
  assert.ok(match, "CONTAINER_PREFIX's shape changed; the role-alternation extraction no longer matches "
    + "it -- this test now examines nothing and must be re-read, not just re-run");
  return match[1].split("|");
}

function pythonAcceptedBareWords(): string[] {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../scorer/python/screenreader_features.py"), "utf8");
  const landmarkRoles = /LANDMARK_ROLES = \{([^}]*)\}/.exec(source);
  const extraUnion = /LANDMARK_ROLES \| \{([^}]*)\}/.exec(source);
  assert.ok(landmarkRoles && extraUnion,
    "screenreader_features.py's CONTAINER_PREFIX no longer builds its alternation from LANDMARK_ROLES "
    + "unioned with a literal set -- this test's extraction no longer matches the real construction and "
    + "must be re-read, not just re-run");
  const words = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set([...words(landmarkRoles![1]), ...words(extraUnion![1])])];
}

test("the Python featurizer's container prefix differs from the JS worker's by EXACTLY the known words", () => {
  const js = new Set(jsAcceptedBareWords());
  const python = new Set(pythonAcceptedBareWords());
  assert.ok(js.size >= 8, `only ${js.size} word(s) read from the JS worker's regex; its shape changed`);
  assert.ok(python.size >= 8, `only ${python.size} word(s) read from the Python featurizer; its shape changed`);

  const pythonOnly = [...python].filter((word) => !js.has(word)).sort();
  assert.deepEqual(pythonOnly, [...KNOWN_PYTHON_ONLY_WORDS].sort(),
    `the Python featurizer accepts ${JSON.stringify(pythonOnly)} as bare container prefixes that the JS `
    + `worker does not. If this is a NEW word, it is an unpinned divergence -- decide whether it is real `
    + `(add it to the JS worker and re-run evidence:check) or add it to KNOWN_PYTHON_ONLY_WORDS with the `
    + `reason, dated. If a listed word is now GONE from this list, the regex was edited -- remove it from `
    + `KNOWN_PYTHON_ONLY_WORDS, it would otherwise hide a real narrowing.`);

  // BOTH DIRECTIONS. The JS worker accepting a word the Python featurizer does not would be a hole on the
  // Python side -- a feature silently blind to a container word the worker already strips.
  const jsOnly = [...js].filter((word) => !python.has(word)).sort();
  assert.deepEqual(jsOnly, [],
    `the JS worker accepts ${JSON.stringify(jsOnly)} that the Python featurizer does not -- a container `
    + `word stripped from the capture but never from the featurizer's own reading of the same announcement`);
});
