/**
 * THE PUBLISHED PACKAGE CARRIES ITS LAUNCHER (ADR 0045 cut 5 of 9, a11ign/a11ign#5083).
 *
 * A host installs `@a11ign/screenreader-worker` and starts the worker from `node_modules`, so the launcher
 * has to be inside the tarball, and it has to run from there. `src/run-server.cmd` is the checkout's copy: it
 * assumes the package sits three levels under a checkout root and starts `server.ts`, and neither holds once
 * the package is installed. `launcher/run-server.cmd` is the published form. This test asks the tarball, not
 * the working tree, so a `files` entry that drops the launcher fails here and not on a host.
 *
 * The lock script is copied byte-for-byte from the fleet repo. The fleet's own copy is not read by this test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PUBLISHED_LAUNCHER = "launcher/run-server.cmd";
const PUBLISHED_LOCK_SCRIPT = "launcher/apply-foreground-lock-timeout.ps1";
const REQUIRED_IN_PACK = [PUBLISHED_LAUNCHER, PUBLISHED_LOCK_SCRIPT];

/**
 * What a published launcher must not name. `packages\` is the checkout layout the launcher used to climb into;
 * `server.ts` is the source it used to run, which a published package does not ship.
 */
const FORBIDDEN_IN_LAUNCHER = ["packages\\", "server.ts"];

/** The file list `npm pack` would publish. `--ignore-scripts` keeps prepack (a build) out of a file-list read. */
function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  const [pack] = JSON.parse(out) as { files: { path: string }[] }[];
  return pack.files.map((file) => file.path);
}

/** The required paths the pack does not list. */
function missingFrom(packed: string[], required: string[]): string[] {
  return required.filter((path) => !packed.includes(path));
}

/** The forbidden spellings the launcher text names. */
function forbiddenIn(launcherText: string): string[] {
  return FORBIDDEN_IN_LAUNCHER.filter((spelling) => launcherText.includes(spelling));
}

const launcherText = () => readFileSync(join(PACKAGE_ROOT, PUBLISHED_LAUNCHER), "utf8");

test("the pack lists the launcher and the lock script it runs beside itself", () => {
  const packed = packedFiles();
  // A pack that lists nothing would make the check below pass vacuously, so the control is named here:
  // package.json is always published, and its presence proves the listing was read.
  assert.ok(packed.includes("package.json"), "the pack listing must be read, not empty");
  assert.deepEqual(missingFrom(packed, REQUIRED_IN_PACK), []);
});

test("the check refuses a pack that does not list the launcher", () => {
  // Negative control: the same check fails on a listing without the launcher.
  assert.deepEqual(missingFrom(["package.json", "dist/server.mjs"], REQUIRED_IN_PACK), REQUIRED_IN_PACK);
});

test("the published launcher starts dist/server.mjs and names no checkout path", () => {
  const text = launcherText();
  assert.ok(text.includes("dist\\server.mjs"), "the launcher must start the built server");
  assert.deepEqual(forbiddenIn(text), []);
});

test("the spelling check flags the pre-#5083 shapes it exists for", () => {
  // Positive control: the forbidden spellings are caught where they occur.
  assert.deepEqual(forbiddenIn('"%~dp0server.ts"'), ["server.ts"]);
  assert.deepEqual(forbiddenIn('cd /d "%~dp0..\\..\\..\\packages\\nvda-worker"'), ["packages\\"]);
});

test("mutation: pointing the launcher back at server.ts fails the launcher check", () => {
  // The mutant is the launcher as it was before #5083, with its one server reference restored.
  const mutant = launcherText().replace("dist\\server.mjs", "server.ts");
  assert.notEqual(mutant, launcherText(), "the mutation must change the text it claims to change");
  assert.deepEqual(forbiddenIn(mutant), ["server.ts"]);
});
