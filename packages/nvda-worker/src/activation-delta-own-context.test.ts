// #1467: AN ACTIVATION'S DELTA IS THE PAGE'S SPEECH, NOT THE CONTROL RE-ANNOUNCING ITSELF.
//
// Rehearsal 4 (#915) captured https://www.w3.org/WAI twice at one commit, with one task. The third form
// probe pressed `Submit Search, graphic, button` on an empty search, the page stayed where it was, and
// `interaction.formChanges[2].after` read "search landmark" in one run and "button" in the other. Neither
// is anything the page said. Both are pieces of the pressed control's own focus announcement, which NVDA
// speaks as separate phrases (both runs' `transcript[6]` is "search landmark, Search:, Search, edit, Search,"
// and `transcript[7]` is "button, graphic, Submit Search"). The delta caught a different piece each time.
// `after` is compared evidence, so the two runs read CHANGED with no code change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stripComments } from "@a11ign/evidence/source-text";
import { onlyControlState, pageSpeechAfter } from "./capture-pure.mjs";

// Quoted from each run's `a11ign-result.json`, `interaction.formChanges`: run 34781484432 (sha256
// f32affb374e13b97…) and run 34782000257 (sha256 a09bfa38c473e6ab…), DanBeckDev/a11ign-v1-rehearsal.
const SUBMIT_SEARCH = "Submit Search, graphic, button";
const RUN_1_DELTA = ["search landmark"];
const RUN_2_DELTA = ["button"];

// The other four entries, equal in both runs. `after` is the delta's phrases joined with " | ".
const UNCHANGED_ENTRIES = [
  { control: "Making the Web Accessible, region, Hide Section, –, button, expanded",
    after: "Show information about W 3C, WAI, You plus, collapsed" },
  { control: "banner landmark, Meta and Search, navigation landmark, list, with 3 items, search landmark, "
      + "Submit Search, graphic, button",
    after: "Search Web Accessibility Initiative (WAI) W 3C, document" },
  { control: "Search, button", after: "Search:, edit, required, At least 3 characters, blank" },
  { control: "Change Text Size or Colors, link",
    after: "How to Change Text Size or Colors Web Accessibility Initiative (WAI) W 3C, document" },
];

test("#1467: the two rehearsal-4 runs' recorded submit deltas resolve to one `after`", () => {
  // Positive control: joined as capture joined them before, the pair differs. That is the defect.
  assert.notEqual(RUN_1_DELTA.join(" | "), RUN_2_DELTA.join(" | "));
  const run1 = pageSpeechAfter(SUBMIT_SEARCH, RUN_1_DELTA);
  const run2 = pageSpeechAfter(SUBMIT_SEARCH, RUN_2_DELTA);
  assert.equal(run1, run2, "two identical runs must record the same page speech for one submit");
  assert.equal(run1, "", "neither fragment is anything the page said");
});

test("#1467 CONTROL: page speech that follows the control's own fragment is kept", () => {
  assert.equal(pageSpeechAfter(SUBMIT_SEARCH, ["search landmark", "3 results found"]), "3 results found");
  assert.equal(pageSpeechAfter(SUBMIT_SEARCH, ["button", "Enter a search term"]), "Enter a search term");
  assert.equal(pageSpeechAfter(SUBMIT_SEARCH, ["Error: enter a search term", "graphic"]),
    "Error: enter a search term");
  // A phrase is dropped only when EVERY part of it is the control's own; one unattributable part keeps it.
  assert.equal(pageSpeechAfter(SUBMIT_SEARCH, ["search landmark, 3 results found"]),
    "search landmark, 3 results found");
});

test("#1467 CONTROL: the pair's other four entries keep exactly the `after` each run recorded", () => {
  for (const { control, after } of UNCHANGED_ENTRIES) {
    assert.equal(pageSpeechAfter(control, after.split(" | ")), after, control);
  }
});

test("#1467: a whole re-announcement, in any order, is the control's own", () => {
  assert.equal(pageSpeechAfter(SUBMIT_SEARCH, ["button, graphic, Submit Search"]), "");
  assert.equal(pageSpeechAfter(SUBMIT_SEARCH, ["search landmark, Submit Search, graphic, button"]), "");
  assert.equal(pageSpeechAfter(SUBMIT_SEARCH, ["", "  ", "search landmark,"]), "");
});

test("#1467: a control's STATE word is never stripped -- the second wait and the reading side own that", () => {
  // `waitPastControlState` waits again when only state was heard, and a toggle's recorded "checked" is what
  // signal-predicates.mjs's `pageResponseTo` reads. Stripping it here would change a toggle's evidence.
  assert.equal(pageSpeechAfter("Bags, check box, not checked", ["checked"]), "checked");
  assert.equal(pageSpeechAfter("Menu, button, expanded", ["expanded"]), "expanded");
  assert.equal(onlyControlState(["checked"]), true);
  assert.equal(onlyControlState(["button"]), false);
});

test("#1467 WIRING: activateAndCaptureDelta records `after` through pageSpeechAfter", () => {
  const source = stripComments(readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8"));
  const at = source.indexOf("async function activateAndCaptureDelta");
  assert.notEqual(at, -1, "activateAndCaptureDelta no longer exists under that name");
  const body = source.slice(at);
  const delta = body.slice(0, body.indexOf("\n}\n"));
  assert.match(delta, /const after = pageSpeechAfter\(phrase, log\.slice\(before\)\);/,
    "`after` is no longer the page's speech with the control's own left out");
  assert.match(delta, /const entry = \{ control: phrase, kind, after,/, "the entry no longer records that `after`");
});
