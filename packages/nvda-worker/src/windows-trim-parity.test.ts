/**
 * `windows-trim.mjs`'s allow/deny lists have a second copy, in PowerShell, for a reason that cannot be
 * removed rather than an oversight -- see `build-lean-worker-image.ps1`'s own header: it trims a mounted
 * WIM OFFLINE, before Windows first boots, which is a different execution context from `windows-trim.mjs`
 * (a live guest at boot, run via `node`). `provision-nvda-worker.ps1` was audited alongside this and is
 * NOT a third copy -- it calls `node windows-trim.mjs` directly (its own comment: "holds the authoritative
 * allow/deny lists"), so there is nothing there to pin.
 *
 * Two languages, so neither CLAUDE.md remedy of "delete a copy" or "derive one from the other" is
 * available -- `windows-trim.mjs` cannot import PowerShell and `build-lean-worker-image.ps1` cannot import
 * `.mjs`. This is the genuinely-forced case the remedy order reserves for a test, the same shape
 * `name-normalisation.test.ts` and `vocabulary-parity.test.ts` already use across this exact boundary.
 *
 * MEASURED before this test existed, audit §9, 2026-09-06: the two `REMOVABLE_APPX`/
 * `$RemovableAppxPrefixes` lists (32 entries) already agreed exactly, in the same order. The two
 * `KEEP_PATTERNS`/`$NeverRemovePatterns` lists did not -- the PowerShell copy carried `servicingstack` and
 * the JS one did not, a genuine drift this test would have caught the day it happened. Closed by adding it
 * to `windows-trim.mjs` (the side documented as authoritative) rather than removing it from the PowerShell
 * copy, since a keep-pattern only ever makes removal MORE conservative.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REMOVABLE_APPX, KEEP_PATTERNS } from "./windows-trim.mjs";

const PS1 = fileURLToPath(
  new URL("../../worker-fleet/src/provisioning/build-lean-worker-image.ps1", import.meta.url));
const ps1Text = readFileSync(PS1, "utf8");

/** Pull a PowerShell `$Name = @( 'a', 'b', ... )` array's string literals out, in order. */
function ps1Array(varName: string): string[] {
  const re = new RegExp(`\\$${varName}\\s*=\\s*@\\(([\\s\\S]*?)\\)`, "m");
  const match = ps1Text.match(re);
  assert.ok(match, `could not find "$${varName} = @( ... )" in ${PS1} -- the PowerShell array syntax `
    + "changed and this pattern needs updating, not the parity check dropped.");
  return [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test("build-lean-worker-image.ps1's arrays are still found -- the vacuity guard for the parse itself", () => {
  const appx = ps1Array("RemovableAppxPrefixes");
  const keep = ps1Array("NeverRemovePatterns");
  assert.ok(appx.length >= 20, `parsed only ${appx.length} Appx prefixes out of the PowerShell file`);
  assert.ok(keep.length >= 5, `parsed only ${keep.length} keep-patterns out of the PowerShell file`);
});

test("REMOVABLE_APPX (windows-trim.mjs) and $RemovableAppxPrefixes (build-lean-worker-image.ps1) agree", () => {
  const ps1Appx = ps1Array("RemovableAppxPrefixes");
  assert.deepEqual(ps1Appx, REMOVABLE_APPX,
    "the offline (PowerShell) and live-guest (JS) removable-package lists have drifted -- a package "
    + "removable on one path and kept on the other is exactly the shape audit §9 flags. Update whichever "
    + "list is behind, in the order the mismatch names them.");
});

test("KEEP_PATTERNS (windows-trim.mjs) and $NeverRemovePatterns (build-lean-worker-image.ps1) agree", () => {
  const ps1Keep = ps1Array("NeverRemovePatterns");
  assert.deepEqual([...ps1Keep].sort(), [...KEEP_PATTERNS].sort(),
    "the offline (PowerShell) and live-guest (JS) keep-lists have drifted -- a pattern protected on one "
    + "path and removable on the other is the more dangerous direction, since it can take out Edge or the "
    + "speech stack on only one of the two provisioning routes.");
});
