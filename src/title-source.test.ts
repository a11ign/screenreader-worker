/**
 * `titleSourceVerdict` (`capture-pure.mjs`) — known-gaps.md §44. NVDA's spoken report of the page title
 * (`reportedTitle`) is the LAST THING NVDA SAID, which on a page whose focus lands in a live region is
 * that region's announcement, not the title. Measured on `design-system.service.gov.uk/components/
 * checkboxes/`: `titleAfter` read `"No search results"`, missing the ` - Profile 1 - Microsoft Edge`
 * suffix a real window title always carries.
 *
 * These are the three states `probeFocusContext`/`probeTypedFeedback`/`probeRouteChange` need out of
 * `currentTitle` (capture-probes.mjs): a trusted document read, an untrusted one falling back to NVDA's
 * report, and the divergence flag that only means something when the document read WAS trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { titleSourceVerdict } from "./capture-pure.mjs";

test("a confirmed CDP target: the document's own title wins, even when it differs from what NVDA said", () => {
  // This is the exact defect: NVDA said the live region, not the title.
  const verdict = titleSourceVerdict({
    domTitle: "Checkboxes – GOV dot UK Design System",
    spokenTitle: "No search results",
    targetMatch: "matched",
  });
  assert.deepEqual(verdict, {
    title: "Checkboxes – GOV dot UK Design System", source: "document", diverged: true,
  });
});

test("a confirmed CDP target, and the two agree: no divergence to report", () => {
  const verdict = titleSourceVerdict({
    domTitle: "Example page", spokenTitle: "Example page", targetMatch: "matched",
  });
  assert.deepEqual(verdict, { title: "Example page", source: "document", diverged: false });
});

test("an unconfirmed CDP target ('fallback'): fall back to what NVDA said, never claim divergence", () => {
  // Reusing `focusTargetIsSuspect`'s own rule -- "fallback" is always suspect, whatever `candidates` is.
  const verdict = titleSourceVerdict({
    domTitle: "Some other document entirely", spokenTitle: "Example page",
    targetMatch: "fallback", candidates: 1,
  });
  assert.deepEqual(verdict, { title: "Example page", source: "spoken", diverged: false },
    "an unconfirmed document title must not be trusted, and comparing it against NVDA proves nothing");
});

test("'no-expected-url' with several candidates open: fall back, nothing to confirm the target against", () => {
  // No comparison was even attempted (a call outside an active capture) -- `candidates` is the only
  // information available there, and more than one open page makes which document answered ambiguous.
  const verdict = titleSourceVerdict({
    domTitle: "Ambiguous", spokenTitle: "Example page", targetMatch: "no-expected-url", candidates: 3,
  });
  assert.deepEqual(verdict, { title: "Example page", source: "spoken", diverged: false });
});

test("a capture from before targetMatch existed at all (undefined, no candidates): trust the document", () => {
  // `focusTargetIsSuspect(undefined)` reads as NOT suspect -- this capture predates the field, and cannot
  // retroactively be accused of a fault nobody checked for. Same rule `focusResetOutcome` already applies.
  const verdict = titleSourceVerdict({ domTitle: "Example page", spokenTitle: "Example page" });
  assert.deepEqual(verdict, { title: "Example page", source: "document", diverged: false });
});

test("no document title read at all (the CDP call failed): fall back to NVDA, whatever the target says", () => {
  const verdict = titleSourceVerdict({
    domTitle: null, spokenTitle: "Example page", targetMatch: "matched",
  });
  assert.deepEqual(verdict, { title: "Example page", source: "spoken", diverged: false });
});

test("REAL PAGE SHAPE: design-system.service.gov.uk/components/checkboxes/ -- the case this fix exists for", () => {
  // Verbatim from the finding: a confirmed target, a real title with its browser-chrome suffix, and NVDA's
  // spoken report was the search autocomplete's live region instead.
  const verdict = titleSourceVerdict({
    domTitle: "Checkboxes – GOV dot UK Design System",
    spokenTitle: "No search results",
    targetMatch: "matched", candidates: 1,
  });
  assert.equal(verdict.title, "Checkboxes – GOV dot UK Design System",
    "3.2.1 must compare the real title, not the live region that spoke on focus");
  assert.equal(verdict.diverged, true, "the divergence is itself evidence of this defect and must be kept");
});
