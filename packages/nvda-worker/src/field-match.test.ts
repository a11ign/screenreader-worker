// THE SECOND IMPLEMENTATION, PINNED TO THE FIRST.
//
// A forms config addresses fields by ACCESSIBLE NAME, so the worker must decide whether the control it
// just landed on is the one the author meant. The authoritative answer is `parseAnnouncement`, and the
// worker cannot import it: it depends on `@guidepup/guidepup` and nothing else, is git-cloned onto Windows
// boxes, and runs under plain node with no build step. A dependency on compiled TypeScript would put a
// `dist` on the capture path, which CLAUDE.md records the cost of.
//
// So the copy is forced, and this is the remedy the repo prefers when it is: pin them equal rather than
// hope. `namesOf` beside `comparableNames` is the same shape, and `name-normalisation.test.ts` failed
// twice on its first run — on cases nobody had considered — which is the argument for doing it here too.
//
// THE PROPERTY: whatever name the grammar extracts from a real announcement, the worker's matcher must be
// able to find. That is exactly the contract between the draft emitter (which names fields using the
// grammar) and the worker (which has to locate them).
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAnnouncement } from "@a11y-witness/evidence";
import { matchesFieldName, matchesWithin, fillActionFor } from "./field-match.mjs";

/**
 * Real announcements, captured from real pages by real NVDA — `runs/real-page-corpus`, 2026-09-02.
 *
 * A FIXTURE rather than a corpus read, so this runs in CI where `runs/` does not exist. The repo's rule is
 * that a test must not derive expectations from source text; it may assert against a fixture, and these
 * are evidence rather than invention.
 */
const REAL_ANNOUNCEMENTS = [
  "Search, edit",
  "Search, edit, Search",
  "Email:, edit, joe at example dot com",
  "Name (required):, edit, required",
  "Number:, spin button, editable, 0",
  "Course:, combo box, collapsed",
  "Offers from associated companies, check box, not checked",
  "Central Park, radio button, not checked",
  "Submit Search, graphic, button",
  "complementary landmark, form, Shipping Address:, grouping, Name:, edit",
  "complementary landmark, form, Subscribe to newsletter, check box, not checked",
  "main landmark, complementary landmark, form, Search:, edit",
  "form, Favorite Park, grouping, None, radio button, not checked",
  "Time:, grouping, Show time picker, menu button, sub Menu",
  "Greenest City, grouping, cities of the world, combo box, collapsed, select a city from this list",
];

test("whatever the GRAMMAR names, the worker's matcher can find", () => {
  // The contract between the draft emitter and the worker, asserted over real evidence rather than over
  // examples chosen to pass. A failure here means a config this tool GENERATED names a field this tool
  // cannot then locate — which would present as a form that silently did not get filled.
  let checked = 0;
  for (const announced of REAL_ANNOUNCEMENTS) {
    const named = parseAnnouncement(announced, "sweep").objects.find((o) => o.name !== "");
    if (!named) continue;
    checked += 1;
    assert.ok(matchesFieldName(announced, named.name),
      `the grammar reads the name as ${JSON.stringify(named.name)} in ${JSON.stringify(announced)}, `
      + "and the worker's matcher cannot find it");
  }
  // Without this the loop could pass having skipped everything — the count-based check this repo keeps
  // rediscovering, in the one place whose whole job is to compare two implementations.
  assert.ok(checked >= 10, `expected the grammar to name most of these; it named ${checked}`);
});

test("a name matches a WHOLE segment, never a prefix of a longer one", () => {
  // Splitting on NVDA's separator rather than substring-matching is what stops "Search" matching
  // "Search results", and what stops a short name matching the tail of a longer one. Substring matching
  // would find the wrong control and fill it, which is worse than not finding one at all.
  assert.ok(matchesFieldName("Search, edit", "Search"));
  assert.ok(!matchesFieldName("Search results, edit", "Search"));
  assert.ok(!matchesFieldName("Retype e Mail:, edit", "e Mail:"));
});

test("a VALUE that repeats the name does not confuse the match", () => {
  // "Search, edit, Search" is a real announcement: the field is named Search and its value is Search.
  // Both are segments, so the match succeeds either way — but it must not depend on which one it found.
  assert.ok(matchesFieldName("Search, edit, Search", "Search"));
  assert.ok(matchesFieldName("Email:, edit, joe at example dot com", "Email:"));
});

test("`within` filters by the group NVDA announced, and asks nothing when absent", () => {
  const shipping = "complementary landmark, form, Shipping Address:, grouping, Name:, edit";
  assert.ok(matchesFieldName(shipping, "Name:"));
  assert.ok(matchesWithin(shipping, "Shipping Address:"));
  assert.ok(!matchesWithin(shipping, "Billing Address:"));
  // No group asked for means no constraint — not "no group found", which would refuse every field on a
  // page NVDA did not announce a grouping for.
  assert.ok(matchesWithin(shipping, undefined));
  assert.ok(matchesWithin("Search, edit", undefined));
});

test("comparison survives casing and odd whitespace", () => {
  // NVDA lower-cases roles and passes names through as authored, and a config transcribed by hand will
  // not always match casing. A non-breaking space where the config has an ordinary one is the U+FFFC and
  // U+E604 lesson in a third alphabet — both cost real time before anyone looked at the bytes.
  assert.ok(matchesFieldName("Email Address:, edit", "email address:"));
  assert.ok(matchesFieldName("Full name, edit", "Full name"));
});

test("the verb decides the action, and a missing verb is null rather than a default", () => {
  assert.deepEqual(fillActionFor({ value: "ada@example.test" }), { action: "type", text: "ada@example.test" });
  assert.deepEqual(fillActionFor({ choose: "Double" }), { action: "choose", option: "Double" });
  assert.deepEqual(fillActionFor({ check: false }), { action: "toggle", to: false });
  // An empty string is a REAL instruction — "clear this field" is how you produce a validation error, and
  // it is the value the drafted error state carries. Falsy-checking it would silently skip the field the
  // whole error state exists to empty.
  assert.deepEqual(fillActionFor({ value: "" }), { action: "type", text: "" });
  // Null, not a guess. The schema refuses a verbless field at parse time, so reaching here means the
  // worker was sent something the CLI would not produce, and defaulting would hide that.
  assert.equal(fillActionFor({}), null);
});
