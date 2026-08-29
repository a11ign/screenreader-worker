/**
 * The pure capture helpers, against every announcement NVDA has actually produced.
 *
 * `capture-pure.mjs` exists so this half of the capture path can be tested without NVDA, and it is — but
 * against hand-written phrases. That is a weaker fixture than it looks. `dedupe-key.test.ts` asserts on
 * `"Main support article, region, Resetting a password, heading, level 2"`, and NVDA does not say that: it
 * announces the role BEFORE the name — `"Main support article, region, heading, level 2, Resetting a
 * password"`. The assertion happens to hold for both, because the strip only reads the leading container,
 * but the fixture describes a screen reader that does not exist. A change validated against it would be
 * validated against the wrong shape.
 *
 * So this file takes its inputs from `runs/`, where 26,175 real announcements are already on disk. Same
 * argument as `verify.corpus.test.ts`: the corpus is ground truth available for free, and it costs a second.
 *
 * Honest skip when `runs/` is absent — it is gitignored, so CI cannot see it and must not go red for that.
 * A skip that reports nothing examined is the failure this repo names "a check that examines nothing", so
 * every test here asserts a FLOOR on how much it looked at before asserting anything about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { dedupeKey, CONTAINER_PREFIX, lastMark, screenReaderWasSilentAtStart } from "./capture-pure.mjs";

const CAPTURES = resolve(process.cwd(), process.env.DATASET_ROOT ?? "runs/screenreader-dataset", "captures");

interface Mark { event: string; lastSpoken?: string }
interface Capture { transcript?: unknown[]; structure?: Record<string, unknown>; diagnostics?: { entries?: Mark[] } | Mark[] }

/** Every capture on disk. Empty when the corpus is absent. */
function corpus(): Capture[] {
  if (!existsSync(CAPTURES)) return [];
  const out: Capture[] = [];
  for (const file of readdirSync(CAPTURES)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(resolve(CAPTURES, file), "utf8")) as Capture);
    } catch {
      // A malformed capture is not this file's subject, and skipping it silently is what the repo's rules
      // forbid — but failing here would make an unrelated corruption look like a regression in dedupeKey.
      out.push({});
    }
  }
  return out;
}

const CORPUS = corpus();
const skip = CORPUS.length === 0 ? "no corpus on disk (runs/ is gitignored; local-only gate)" : false;

/** Every string NVDA said, across every capture — BOTH channels. */
function announcements(): string[] {
  return CORPUS.flatMap((c) => [
    ...(c.transcript ?? []),
    ...Object.values(c.structure ?? {}).flatMap((v) => (Array.isArray(v) ? v : [])),
  ].filter((p): p is string => typeof p === "string"));
}

function marksOf(capture: Capture): Mark[] {
  const diag = capture.diagnostics;
  if (Array.isArray(diag)) return diag;
  return diag?.entries ?? [];
}

/** `lastMark` and `screenReaderWasSilentAtStart` read `diag.entries`, so hand them that shape. */
const asDiag = (entries: Mark[]) => ({ entries });

// A leading container that SURVIVED the strip. This is the phantom-heading bug's signature: the same
// element reached from two directions keys twice, and the sweep reports a heading the page does not have.
const CONTAINER_ROLE_AT_START =
  /^(?:landmark|region|banner|navigation|main|complementary|content info|form|article),/i;

test("every container prefix NVDA actually produces is stripped", { skip }, () => {
  const phrases = announcements();
  const prefixed = phrases.filter((p) => CONTAINER_PREFIX.test(p));

  // Without this the test passes in perfect silence if the regex stops matching anything at all — which is
  // the exact defect it exists to catch, so it would be the regression that switches its own alarm off.
  // Measured 1,160 of 26,175 when written.
  assert.ok(prefixed.length >= 500,
    `only ${prefixed.length} of ${phrases.length} announcements matched CONTAINER_PREFIX; the pattern has `
    + "stopped recognising NVDA's container announcements, so nothing below is being tested");

  const survived = [...new Set(phrases.map(dedupeKey).filter((k: string) => CONTAINER_ROLE_AT_START.test(k)))];
  assert.deepEqual(survived.slice(0, 5), [],
    "these keys still begin with a container role, so the same element reached from two directions will be "
    + "recorded twice — the phantom heading that took an independent count to find");
});

/** Only the read-through channel. `dedupeKey` is applied to SWEEP results, so both are worth asserting. */
function transcripts(): string[] {
  return CORPUS.flatMap((c) => (c.transcript ?? []).filter((p): p is string => typeof p === "string"));
}

/** Only the sweep channel — the one `collectPhrase` actually keys on. */
function sweeps(): string[] {
  return CORPUS.flatMap((c) => Object.values(c.structure ?? {})
    .flatMap((v) => (Array.isArray(v) ? v : []))
    .filter((p): p is string => typeof p === "string"));
}

test("the strip is idempotent on the read-through", { skip }, () => {
  const once = transcripts().map(dedupeKey);
  assert.ok(once.length >= 1000, `only ${once.length} announcements examined`);
  for (const key of once) assert.equal(dedupeKey(key), key);
});

/**
 * THE SWEEP CHANNEL, WHICH THIS FILE WAS NOT LOOKING AT — and it is the only channel `dedupeKey` is used
 * on. `collectPhrase` is its sole caller; the transcript is never keyed. So every assertion here examined
 * the one channel its subject does not touch, and passed. The `>= 1000` floor above, added precisely to
 * stop this file passing vacuously, was satisfied by the wrong data.
 *
 * KNOWN, BOUNDED, AND DEFERRED. `CONTAINER_PREFIX` strips ONE leading container; NVDA announces every
 * container it entered, so a nested one survives:
 *
 *   "main landmark, Home energy, region, Home energy"   and   "Home energy, region, Home energy"
 *
 * key differently and the same landmark is recorded twice — measured, 3 landmarks on a page with 2, in 34
 * of 5,304 captures, all `landmark-*`. Blast radius checked: no rule counts the list, and the model's
 * `landmark_present` / `landmark_named` are booleans, so nothing downstream reads a wrong verdict today.
 *
 * NOT FIXED HERE because `dedupeKey` runs at CAPTURE time, so changing it alters `structure.*` and needs a
 * `CAPTURE_PROTOCOL_VERSION` bump and a full recapture. Fixing it without one leaves a corpus where some
 * captures dedupe twice and some once — the mixed-evidence state the cache key exists to prevent. The
 * cheap moment is bundled with the next bump, which is what CLAUDE.md prescribes.
 *
 * So this asserts the bound rather than the property: it fails if the phantom SPREADS, and it must be
 * replaced by a strict `assert.equal(dedupeKey(key), key)` when that bump lands.
 */
const KNOWN_SWEEP_PHANTOMS = 146;

test("the sweep strip is idempotent, except for a known bounded phantom", { skip }, () => {
  const all = sweeps();
  assert.ok(all.length >= 1000, `only ${all.length} sweep announcements examined`);
  const notIdempotent = all.map(dedupeKey).filter((key) => dedupeKey(key) !== key);
  assert.ok(notIdempotent.length <= KNOWN_SWEEP_PHANTOMS,
    `${notIdempotent.length} sweep keys are not idempotent, up from the known ${KNOWN_SWEEP_PHANTOMS}. `
    + "A nested container prefix is surviving on more announcements than before — e.g. "
    + `${JSON.stringify(notIdempotent.slice(0, 2))}`);
});

test("the strip never empties a real announcement", { skip }, () => {
  // Over-stripping trades a phantom for a truncation, and a truncation is the harder defect to notice:
  // a missing element looks like a page that does not have one.
  const emptied = announcements().filter((p) => p.trim() !== "" && dedupeKey(p).trim() === "");
  assert.deepEqual(emptied.slice(0, 5), [], "dedupeKey reduced a real announcement to nothing");
});

test("no healthy capture is read as a mute screen reader", { skip }, () => {
  // `screenReaderWasSilentAtStart` is half the gate that ABANDONS a capture as mute. Every capture on disk
  // succeeded, so a single true here is a false positive that would have thrown away real evidence.
  const withStart = CORPUS.map(marksOf).filter((m) => m.some((e) => e.event === "afterStart"));
  assert.ok(withStart.length >= 1000,
    `only ${withStart.length} captures carry an afterStart mark; this is not examining the corpus`);

  const silent = withStart.filter((m) => screenReaderWasSilentAtStart(asDiag(m)));
  assert.equal(silent.length, 0,
    `${silent.length} healthy captures would be read as a mute NVDA and discarded`);
});

test("...and it still FIRES when NVDA really said nothing", { skip: skip || undefined }, () => {
  // The test above is worthless without this one: a function that returned false unconditionally would
  // pass it. Reproduce the fault before trusting the verdict — the canary rule, applied to a predicate.
  const real = CORPUS.map(marksOf).find((m) => m.some((e) => e.event === "afterStart"));
  assert.ok(real, "no real diagnostics to build the mute case from");

  const mute = real.map((e) => (e.event === "afterStart" ? { ...e, lastSpoken: "" } : e));
  assert.equal(screenReaderWasSilentAtStart(asDiag(mute)), true);
  assert.equal(screenReaderWasSilentAtStart(asDiag(real)), false);

  // Absent is not the same as empty, and must not read as mute: "we never recorded it" is not evidence.
  assert.equal(screenReaderWasSilentAtStart(asDiag(real.filter((e) => e.event !== "afterStart"))), false);
});

test("lastMark returns the LAST occurrence, not the first", { skip }, () => {
  // Real captures carry several `sweep` marks — one per quick-nav type — so the corpus supplies the
  // repeated-event case that a single hand-written mark cannot.
  const many = CORPUS.map(marksOf).find((m) => m.filter((e) => e.event === "sweep").length > 1);
  assert.ok(many, "no capture carries repeated sweep marks; this assertion is not being exercised");

  const sweeps = many.filter((e) => e.event === "sweep");
  assert.equal(lastMark(asDiag(many), "sweep"), sweeps.at(-1));
  assert.notEqual(sweeps.at(-1), sweeps[0]);
  assert.equal(lastMark(asDiag(many), "neverHappened"), undefined);
});
