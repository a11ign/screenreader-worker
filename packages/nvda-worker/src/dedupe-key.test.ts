/**
 * Collapsing NVDA's container prefix before deduping a sweep.
 *
 * The SAME element is announced two ways depending on the direction you reach it from: bare, or prefixed
 * with the container the cursor just entered. Keying on the raw phrase records it twice.
 *
 * The prefix has two shapes and only one was handled. `"Main support article, region, Resetting a
 * password, heading, level 2"` separates the container's name from its role with a COMMA, so the strip
 * failed and a page with two headings reported three. Nothing could see it: counts never moved against
 * anything, which is why it took an independent count (Chromium's accessibility tree) to surface.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { dedupeKey } from "./capture-pure.mjs";

test("a space-separated container prefix is stripped", () => {
  assert.equal(
    dedupeKey("main landmark, Children's story time, heading, level 3"),
    "Children's story time, heading, level 3",
  );
});

test("a COMMA-separated container prefix is stripped — the case that produced a phantom heading", () => {
  const bare = "Resetting a password, heading, level 2";
  const prefixed = "Main support article, region, Resetting a password, heading, level 2";
  assert.equal(dedupeKey(prefixed), bare);
  // The point of the strip: both must key IDENTICALLY, or the sweep records the same heading twice.
  assert.equal(dedupeKey(prefixed), dedupeKey(bare));
});

test("an announcement with no container prefix is left alone", () => {
  assert.equal(dedupeKey("Account help, heading, level 1"), "Account help, heading, level 1");
  assert.equal(dedupeKey("Subscribe, button"), "Subscribe, button");
});

test("two genuinely different headings still key differently", () => {
  // The strip must not become so eager that distinct elements collide -- that would trade a phantom for
  // a truncation, which is the harder defect to notice.
  assert.notEqual(
    dedupeKey("Main support article, region, Resetting a password, heading, level 2"),
    dedupeKey("Main support article, region, Account help, heading, level 1"),
  );
});
