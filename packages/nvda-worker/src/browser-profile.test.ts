// What the profile pruner deletes. This is the riskiest thing in the worker: delete the wrong path and
// every capture on that guest silently gains Edge's first-run welcome surface as phantom page content.
// So the decision of WHAT to remove is a pure function, and these are its boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prunablePaths, reportBrowserPolicyDrift } from "./browser-profile.mjs";

const ROOT = "C:\\Users\\witness\\AppData\\Local\\a11y-witness\\edge-profile";
const everythingExists = () => true;

test("a healthy profile keeps its caches but still loses BrowserMetrics", () => {
  // 261 MB was measured running 11-12s captures; dropping its caches pushed it to 63s and it was still
  // only back to ~28s eight captures later. The cache earns its space. BrowserMetrics does not: one file
  // per Edge launch, 348 MB of a 448 MB profile on the busiest guest, and nothing ever reads it.
  const paths = prunablePaths({ megabytes: 261, root: ROOT, exists: everythingExists });
  assert.ok(paths.some((p) => p.endsWith("BrowserMetrics")), "telemetry must go regardless of size");
  assert.ok(!paths.some((p) => p.endsWith("Cache")), "a small profile keeps its warm cache");
});

test("BrowserMetrics is dropped even when the profile size cannot be read", () => {
  // Unknown size must not mean "leave the unbounded directory alone".
  const paths = prunablePaths({ megabytes: null, root: ROOT, exists: everythingExists });
  assert.ok(paths.some((p) => p.endsWith("BrowserMetrics")));
});

test("only a genuinely runaway profile gives up its caches", () => {
  // Deliberately far above anything a healthy guest reaches, because the 200 MB version of this
  // threshold made a working worker 5x slower.
  const paths = prunablePaths({ megabytes: 1_200, root: ROOT, exists: everythingExists });
  assert.ok(paths.length > 0);
  assert.ok(paths.some((p) => p.endsWith("Cache")), "the HTTP cache is the point of this");
});

test("the files that suppress Edge's first-run experience are NEVER removed", () => {
  // The whole reason the profile is durable. Losing these puts the welcome/sign-in surface into
  // captures on any page with no headings — a documented evidence-corruption bug.
  const paths = prunablePaths({ megabytes: 9_999, root: ROOT, exists: everythingExists });
  for (const kept of ["Local State", "Preferences", "Secure Preferences", "First Run"]) {
    assert.ok(!paths.some((p) => p.endsWith(kept)), `${kept} must survive pruning`);
  }
});

test("the profile root itself is never a target", () => {
  // Deleting the root is the same as having no durable profile at all.
  const paths = prunablePaths({ megabytes: 9_999, root: ROOT, exists: everythingExists });
  assert.ok(!paths.includes(ROOT), "pruning must never remove the profile directory");
  for (const p of paths) assert.ok(p.startsWith(ROOT), `${p} escapes the profile directory`);
});

test("session-restore records are removed, so Edge cannot reopen a previous window", () => {
  // A restored window both slows startup and risks restoring page content into a capture.
  const paths = prunablePaths({ megabytes: 1_200, root: ROOT, exists: everythingExists });
  assert.ok(paths.some((p) => p.endsWith("Sessions")), "Sessions drives restore-on-launch");
});

test("paths that do not exist are not offered for deletion", () => {
  assert.deepEqual(prunablePaths({ megabytes: 1_200, root: ROOT, exists: () => false }), []);
});

test("an unreadable profile size never prunes the size-gated caches", () => {
  // Guessing "prune it" on no information is how you throw away a cache that was doing its job.
  const paths = prunablePaths({ megabytes: null, root: ROOT, exists: everythingExists });
  assert.ok(!paths.some((p) => p.endsWith("Cache")));
});

test("the unconditional prune list contains only things Chromium recreates on demand", () => {
  // Guard against re-adding "probably unnecessary" paths. Edge's component payloads were once on this
  // list; the guests have the auto-updater disabled, so deleting them was permanent, and the two
  // workers it happened to went from 11-12s captures to ~26s with no way back.
  //
  // The rule is not "keep it at one entry" — it is that every entry must be regenerable AND unneeded
  // by a capture. An allow-list states that intent directly; a count only pretended to.
  const REGENERABLE_AND_UNNEEDED = [
    "BrowserMetrics",       // telemetry Edge writes and never reads back
    "Web Data",             // autofill store — see below
    "Web Data-journal",
    "Login Data",           // saved credentials; a capture never signs in to anything
    "Login Data-journal",
  ];
  const paths = prunablePaths({ megabytes: 100, root: ROOT, exists: everythingExists });
  for (const path of paths) {
    assert.ok(
      REGENERABLE_AND_UNNEEDED.some((allowed) => path.endsWith(allowed)),
      `${path} is pruned unconditionally but is not on the regenerable allow-list`,
    );
  }
});

test("the autofill store is dropped at EVERY boot, not only on an oversized profile", () => {
  // Correctness, not housekeeping, so it must not be size-gated. probeForms submits forms, which
  // TEACHES the profile; a taught profile then draws a suggestion affordance inside recognised inputs
  // and NVDA announces it as an embedded object appended to the field:
  //     "Recipient name, edit, ￼"   instead of   "Recipient name, edit"
  // The same unchanged page therefore announces differently depending on how many form pages preceded
  // it — measured rising from 3% to 31% over the corpus's life, with 26 good/bad pairs disagreeing.
  //
  // Command-line flags alone did NOT fix this: they stop Edge saving new entries, but it still offers
  // entries the profile already holds. One guest measured 0 of 12 while another kept varying, purely
  // because their profiles had learned different amounts.
  const small = prunablePaths({ megabytes: 10, root: ROOT, exists: everythingExists });
  assert.ok(small.some((p) => p.endsWith("Web Data")), "a small profile must still lose its form data");
  const unknown = prunablePaths({ megabytes: null, root: ROOT, exists: everythingExists });
  assert.ok(unknown.some((p) => p.endsWith("Web Data")), "an unreadable size must not skip it either");
});

test("policy drift is reported once, naming the fix — not attempted and failed", () => {
  // This replaced a boot-time `reg add HKLM\...` that could never succeed (the worker task is not
  // elevated) and printed two "Command failed" lines above a healthy "worker is ready" on every boot.
  const lines: string[] = [];
  const drifted = reportBrowserPolicyDrift({ StartupBoostEnabled: 1, BackgroundModeEnabled: 0 }, (l) => lines.push(l));
  assert.deepEqual(drifted, ["StartupBoostEnabled"]);
  assert.equal(lines.length, 1, "one line, not one per setting");
  assert.match(lines[0], /StartupBoostEnabled=1 \(want 0\)/);
  assert.match(lines[0], /provision-nvda-worker\.ps1/, "must name what actually fixes it");
});

test("a compliant guest logs nothing at all", () => {
  // Boot output is read by humans watching a VM console; silence is the correct output for "fine".
  const lines: string[] = [];
  reportBrowserPolicyDrift({ StartupBoostEnabled: 0, BackgroundModeEnabled: 0 }, (l) => lines.push(l));
  assert.deepEqual(lines, []);
});

test("an unreadable policy is not reported as drift", () => {
  // null means "could not read", which must not be dressed up as a finding.
  const lines: string[] = [];
  assert.deepEqual(reportBrowserPolicyDrift(null, (l) => lines.push(l)), []);
  assert.deepEqual(reportBrowserPolicyDrift({ StartupBoostEnabled: null, BackgroundModeEnabled: null }, (l) => lines.push(l)), []);
  assert.deepEqual(lines, []);
});
