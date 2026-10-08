// THIS REPOSITORY'S COUNT OF .js/.mjs/.cjs SOURCE FILES MAY ONLY GO DOWN (a11ign/a11ign#4263; the rule and its check are
// `@a11ign/toolchain/mjs-ratchet`, ADR 0043). The standard is TypeScript source and `.mjs` only as build output.
//
// This is the test `pnpm test` already runs, so no workflow file carries the check. The baseline is found by walking up from THIS FILE,
// so the layout flatten (#4214) moves the test and edits nothing. The cases below run the same function over copies of the tree, so
// each states what a failure looks like rather than trusting that the real tree never fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "@rstest/core";
import { BASELINE_FILE, checkMjsRatchet, findBaselineRoot, isScriptSource } from "@a11ign/toolchain/mjs-ratchet";

const here = fileURLToPath(import.meta.url);
const root = findBaselineRoot(here);
const baseline = JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8")) as { files: string[]; exceptions: { path: string; why: string }[] };

/** The tree's script sources as the check counts them: tracked, plus untracked and not ignored, outside build output. */
const sourcePaths = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "" && isScriptSource(path));

const scratch = mkdtempSync(join(tmpdir(), "mjs-ratchet-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let copies = 0;
/** A directory with no `.git`, holding an empty file at each of `paths` and the given baseline: the check reads it by walking. */
function copyOfTree({ paths, baselineText }: { paths: string[]; baselineText: string }): string {
  const dir = join(scratch, `copy-${copies++}`);
  for (const path of paths) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "");
  }
  writeFileSync(join(dir, BASELINE_FILE), baselineText);
  return join(dir, BASELINE_FILE);
}

test("the repository's real tree passes against the committed baseline, and the read found files", () => {
  const result = checkMjsRatchet({ from: here });
  assert.equal(result.ok, true, result.message);
  // The positive control for every case below: 'ok' on a read that found nothing would be a pass for the wrong reason.
  assert.ok(result.count > 0, `the ratchet counted ${result.count} files in ${result.root}`);
  assert.equal(result.count, sourcePaths.length - baseline.exceptions.length, "the test's own listing and the check's agree on the population");
  assert.equal(result.baselineCount, baseline.files.length);
});

test("the committed baseline lists BASENAMES (never paths), and every exception states why", () => {
  assert.ok(baseline.files.length > 0, "an empty baseline is the end state, and this repository is not there yet");
  assert.ok(baseline.files.every((name) => !name.includes("/")), "a path in `files` would make a move edit the baseline");
  for (const entry of baseline.exceptions) assert.ok(entry.why.trim() !== "", `exception ${entry.path} has no why`);
});

test("a baseline with one name removed fails and NAMES the file", () => {
  const removed = baseline.files[0];
  const reduced = { ...baseline, files: baseline.files.slice(1) };
  const result = checkMjsRatchet({ from: copyOfTree({ paths: sourcePaths, baselineText: JSON.stringify(reduced) }) });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes(removed), `the failure does not name ${removed}:\n${result.message}`);
});

test("an emptied baseline names EVERY file of the tree (the RED run)", () => {
  const result = checkMjsRatchet({ from: copyOfTree({ paths: sourcePaths, baselineText: JSON.stringify({ files: [], exceptions: [] }) }) });
  assert.equal(result.ok, false);
  const unnamed = baseline.files.filter((name) => !result.message.includes(name));
  assert.deepEqual(unnamed, [], "files the failure did not name");
});

test("a tree that has dropped a file passes and says the baseline can be lowered", () => {
  const result = checkMjsRatchet({ from: copyOfTree({ paths: sourcePaths.slice(1), baselineText: JSON.stringify(baseline) }) });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /can be lowered/);
  assert.equal(result.count, result.baselineCount - 1);
});

test("an exception with no `why` fails", () => {
  const withoutWhy = { files: baseline.files.slice(1), exceptions: [{ path: sourcePaths[0], why: "" }] };
  const result = checkMjsRatchet({ from: copyOfTree({ paths: sourcePaths, baselineText: JSON.stringify(withoutWhy) }) });
  assert.equal(result.ok, false);
  assert.match(result.message, /has no `why`/);
});
