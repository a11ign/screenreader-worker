/**
 * The tab order is a CYCLE, and detecting the wrap is what makes the 150-stop cap a fallback rather
 * than the usual answer.
 *
 * Before this, the cap was 12 and `truncated` meant "hit the cap" — which on real pages was ALWAYS
 * true. Measured 2026-08-24 across 77 real pages: the focus probe truncated on 77 of them, coverage
 * was 924 stops against 6,887 focusable elements (13.4%), and 2.1.1, 2.1.2, 2.4.1 and 2.4.3 came back
 * `cantTell` on almost every page as a result. No corpus page has more than 22 focusable elements, so
 * nothing in the corpus could have shown it.
 *
 * `capture-core.mjs` needs real NVDA on Windows and has no local test. This function is pure, which is
 * exactly the part that can be tested here — and the ambiguity it resolves is one this project has
 * already paid for once, in a sweep that reported 5 graphics of 66 because four avatars announced
 * identically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// capture-core is plain .mjs, deliberately: it runs under bare node on the worker.
import { focusOrderCycled } from "./capture-core.mjs";

const stops = (...phrases: string[]) => phrases;

test("a wrap back to the opening controls is a cycle", () => {
  assert.equal(focusOrderCycled(stops("a", "b", "c", "d", "e", "a", "b", "c")), true);
});

test("ONE repeated phrase is not a cycle — that ambiguity cost 61 graphics once", () => {
  // Four avatars with identical alt text announce identically. If a single match ended the probe, a page
  // whose second control sounds like its first would report a tab order of two.
  assert.equal(focusOrderCycled(stops("a", "b", "c", "d", "e", "a")), false);
  assert.equal(focusOrderCycled(stops("a", "b", "c", "d", "e", "a", "b")), false);
});

test("the recurrence must be IN ORDER, not merely present", () => {
  // The opening phrases reappearing shuffled is a page that reuses labels, not a wrap.
  assert.equal(focusOrderCycled(stops("a", "b", "c", "d", "e", "c", "a", "b")), false);
});

test("a short tab order cannot be mistaken for a cycle", () => {
  // Fewer stops than two confirmations means there is nothing to confirm against. A three-control page
  // whose controls all announce the same must not read as "we walked the whole page".
  assert.equal(focusOrderCycled(stops("a", "a", "a")), false);
  assert.equal(focusOrderCycled(stops()), false);
  assert.equal(focusOrderCycled(stops("a")), false);
});

test("a page walked exactly once, with no wrap, is NOT complete", () => {
  // The case that must stay `truncated`: we stopped because we ran out of budget, not because we
  // returned to the start. Reporting this as complete would assert a clean pass on unexamined content.
  assert.equal(focusOrderCycled(stops("a", "b", "c", "d", "e", "f", "g", "h")), false);
});
