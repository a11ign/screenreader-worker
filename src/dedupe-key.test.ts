/**
 * Collapsing NVDA's container prefix before deduping a sweep.
 *
 * The SAME element is announced two ways depending on the direction you reach it from: bare, or prefixed
 * with the container the cursor just entered. Keying on the raw phrase records it twice.
 *
 * The prefix has two shapes and only one was handled. `"Main support article, region, heading, level 2,
 * Resetting a password"` separates the container's name from its role with a COMMA, so the strip failed and
 * a page with two headings reported three. Nothing could see it: counts never moved against anything, which
 * is why it took an independent count (Chromium's accessibility tree) to surface.
 *
 * **Every phrase below is a real announcement, copied from `runs/`.** They used to be hand-written, and were
 * the wrong shape: they put the heading's name before its role (`"Resetting a password, heading, level 2"`),
 * and NVDA does the opposite — 6,704 real heading announcements are role-first and **none** is name-first.
 * The assertions held anyway, because the strip only reads the LEADING container, so nothing was broken by
 * it; but a fixture that describes a screen reader this project has never observed is one a future change
 * can be validated against and still be wrong. `capture-pure.corpus.test.ts` runs these same functions over
 * all 26,175 announcements on disk, which is the version that cannot drift from what NVDA says.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { dedupeKey } from "./capture-pure.mjs";

test("a space-separated container prefix is stripped", () => {
  // Real: the container's role follows its name with a SPACE ("main landmark"), not a comma.
  assert.equal(
    dedupeKey("main landmark, heading, level 1, Market garden 044 guide"),
    "heading, level 1, Market garden 044 guide",
  );
});

test("a COMMA-separated container prefix is stripped — the case that produced a phantom heading", () => {
  const bare = "heading, level 2, Resetting a password";
  const prefixed = "Main support article, region, heading, level 2, Resetting a password";
  assert.equal(dedupeKey(prefixed), bare);
  // The point of the strip: both must key IDENTICALLY, or the sweep records the same heading twice.
  assert.equal(dedupeKey(prefixed), dedupeKey(bare));
});

test("an announcement with no container prefix is left alone", () => {
  assert.equal(dedupeKey("heading, level 1, Archive"), "heading, level 1, Archive");
  assert.equal(dedupeKey("Archive selected messages"), "Archive selected messages");
});

test("two genuinely different headings still key differently", () => {
  // The strip must not become so eager that distinct elements collide -- that would trade a phantom for
  // a truncation, which is the harder defect to notice.
  assert.notEqual(
    dedupeKey("Main support article, region, heading, level 2, Resetting a password"),
    dedupeKey("Park gate information, region, heading, level 2, Park gate information"),
  );
});

test("EVERY container prefix is stripped, not just the first", () => {
  // known-gaps §18. NVDA announces every container it entered, so the same landmark reached from outside
  // and from inside keyed two ways and `structure.landmarks` reported 3 on a page with 2. Measured: 146
  // of 24,774 sweep announcements, 34 captures, all `landmark-*`.
  assert.equal(
    dedupeKey("main landmark, Home energy, region, Home energy"),
    dedupeKey("Home energy, region, Home energy"),
    "the same landmark reached from two directions must key identically");
});

test("nested landmarks collapse to the element's own name", () => {
  assert.equal(dedupeKey("main landmark, navigation landmark, Home, heading, level 2"),
    dedupeKey("Home, heading, level 2"));
});

test("stripping repeatedly never empties a real announcement", () => {
  // The over-strip signature, and the reason this was verified against the corpus before being applied:
  // across all 24,774 sweep announcements, 146 keys change and NONE is reduced to nothing. An empty key
  // would collapse unrelated elements into one, trading a phantom for a truncation — the harder defect to
  // notice, because a missing element looks like a page that does not have one.
  for (const phrase of [
    "main landmark, navigation landmark, Home, heading, level 2",
    "Home energy, region, Home energy",
    "form, Full name",
    "Archive selected messages",
  ]) {
    assert.notEqual(dedupeKey(phrase).trim(), "", `dedupeKey emptied ${JSON.stringify(phrase)}`);
  }
});

test("the strip is idempotent, which is what stripping to a fixed point buys", () => {
  // Before §18 a key could depend on how many times it was taken; `capture-pure.corpus.test.ts` carried a
  // BOUNDED assertion (146 known non-idempotent sweep keys) precisely because of it. That bound can go.
  for (const phrase of [
    "main landmark, Home energy, region, Home energy",
    "main landmark, navigation landmark, Home, heading, level 2",
    "heading, level 1, Archive",
  ]) {
    assert.equal(dedupeKey(dedupeKey(phrase)), dedupeKey(phrase));
  }
});

