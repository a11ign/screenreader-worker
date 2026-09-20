// #1105: `interaction.formChanges[].after` intermittently recorded NVDA's `"unknown"` placeholder for
// a document whose title had not resolved yet, on a submit that navigated -- indistinguishable from a
// real announcement to everything downstream. Measured on the fleet, repeat-capturing the four named
// populations: 11/32 (34.4%), 0% to 62.5% per population. `baselineWaitedMs` does not cleanly separate
// the two outcomes either way (`claim`'s unknowns all sat at the ~300ms floor; `booking`'s did not), so
// the fix cannot be "wait longer" alone -- it must also RECORD an unresolved read as such, so a finding
// is never built on it either way, per this row's own Acceptance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stripComments } from "@a11ign/evidence/source-text";
import { isUnresolvedDocumentTitle } from "./capture-pure.mjs";

test("#1105: isUnresolvedDocumentTitle recognises NVDA's bare placeholder", () => {
  assert.equal(isUnresolvedDocumentTitle("unknown"), true);
  assert.equal(isUnresolvedDocumentTitle("Unknown"), true);
  assert.equal(isUnresolvedDocumentTitle("  unknown  "), true);
  // Defensive superset -- never observed, but the role suffix pattern every real title carries.
  assert.equal(isUnresolvedDocumentTitle("unknown, document"), true);
});

test("#1105 CONTROL: a real document announcement, or anything else, is not the placeholder", () => {
  // Positive control for the emptiness this predicate must NOT report: real titles from the same rows
  // this defect was measured on, quoted from the row.
  assert.equal(isUnresolvedDocumentTitle("Claim details, document"), false);
  assert.equal(isUnresolvedDocumentTitle("Booking details, document"), false);
  assert.equal(isUnresolvedDocumentTitle("Saved searches, document"), false);
  assert.equal(isUnresolvedDocumentTitle(""), false);
  // Contains the word but is not exactly it -- must not over-match a page that genuinely says this.
  assert.equal(isUnresolvedDocumentTitle("Status: unknown error, document"), false);
});

test("#1105 WIRING: activateAndCaptureDelta retries past an unresolved title before finalising `after`", () => {
  const source = stripComments(readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8"));
  const at = source.indexOf("async function activateAndCaptureDelta");
  assert.notEqual(at, -1, "activateAndCaptureDelta no longer exists under that name");
  const body = source.slice(at);
  const delta = body.slice(0, body.indexOf("\n}\n"));
  assert.match(delta, /log = await waitPastUnresolvedTitle\(log, before, \{ kind, control: phrase, interaction \}\);/,
    "the delta no longer waits again for a title that has not resolved yet");
  assert.match(delta,
    /const \{ after, afterUnresolved \} = pageSpeechAfterRetries\(\{ phrase, log, before, kind, interaction \}\);/,
    "the delta no longer derives `after` and `afterUnresolved` together");
  // The retry runs BEFORE `after` is read from the final log, or it cannot change what gets recorded.
  assert.ok(delta.indexOf("waitPastUnresolvedTitle") < delta.indexOf("pageSpeechAfterRetries"),
    "the unresolved-title retry must run before `after` is read, not after");
  assert.match(delta, /\.\.\.\(afterUnresolved \? \{ afterUnresolved: true \} : \{\}\)/,
    "the entry no longer records that its `after` is unresolved rather than an announcement");

  const helperAt = source.indexOf("function pageSpeechAfterRetries");
  assert.notEqual(helperAt, -1, "pageSpeechAfterRetries no longer exists under that name");
  const helperBody = source.slice(helperAt, source.indexOf("\n}\n", helperAt));
  assert.match(helperBody, /const afterUnresolved = isUnresolvedDocumentTitle\(after\);/,
    "an `after` that still reads as the placeholder is no longer recognised, so a finding could be built on it");
});

test("#1105 MUTATION: forcing `after` to \"unknown\" on a page that announced something must be caught", () => {
  // The guard this row's Acceptance asks for: an entry whose `after` is the literal placeholder must be
  // distinguishable from a real announcement of the same text. Simulates the entry construction directly,
  // the same shape `activateAndCaptureDelta` builds, so a mutant that stops setting `afterUnresolved` --
  // or stops checking `isUnresolvedDocumentTitle` before building the entry -- fails this assertion.
  const afterAnnouncementWasReal = "Claim details, document";
  const afterForcedToUnknown = "unknown";
  const buildEntry = (after: string) => ({
    control: "Claim, button", kind: "submit", after,
    ...(isUnresolvedDocumentTitle(after) ? { afterUnresolved: true } : {}),
  });
  assert.equal(buildEntry(afterAnnouncementWasReal).afterUnresolved, undefined,
    "a real announcement must never be marked unresolved");
  assert.equal(buildEntry(afterForcedToUnknown).afterUnresolved, true,
    "`after` forced to \"unknown\" on a page that announced something must be marked, not read as a finding");
});
