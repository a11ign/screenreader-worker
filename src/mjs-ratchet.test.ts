// THIS REPOSITORY HAS NO .js/.mjs/.cjs SOURCE FILE, AND THE BASELINE IS EMPTY, SO A NEW ONE FAILS (a11ign/a11ign#4263, #4279; the rule
// and its check are `@a11ign/toolchain/mjs-ratchet`, ADR 0043). The standard is TypeScript source and `.mjs` only as build output.
//
// This is the test `pnpm test` already runs, so no workflow file carries the check. The baseline is found by walking up from THIS FILE,
// so the layout flatten (#4214) moves the test and edits nothing. The cases below run the same function over copies of the tree, so
// each states what a failure looks like rather than trusting that the real tree never fails: with nothing left to count, the real tree
// can no longer show the check biting, so the synthetic trees below are the positive control for the first case.
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

/** A tree with files in it and none of them a script source: an empty tree is RED by the check's own rule, and is not what these cases test. */
const TYPESCRIPT_TREE = ["src/server.ts", "package.json"];
const EMPTY_BASELINE = JSON.stringify({ files: [], exceptions: [] });

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

test("the repository's real tree passes against the committed baseline, which is EMPTY: the end state", () => {
  const result = checkMjsRatchet({ from: here });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.count, 0, `script sources are back in ${result.root}:\n${sourcePaths.join("\n")}`);
  assert.equal(result.baselineCount, 0);
  assert.equal(sourcePaths.length - baseline.exceptions.length, result.count, "the test's own listing and the check's agree on the population");
});

test("the committed baseline allows nothing, and every exception states why", () => {
  assert.deepEqual(baseline.files, [], "the baseline is the end state: a file listed here is a file that was not converted");
  for (const entry of baseline.exceptions) assert.ok(entry.why.trim() !== "", `exception ${entry.path} has no why`);
});

test("a tree that has a script source the baseline does not list fails and NAMES it (the RED run, and the control for the case above)", () => {
  const added = "src/arrived-later.mjs";
  const result = checkMjsRatchet({ from: copyOfTree({ paths: [...TYPESCRIPT_TREE, added], baselineText: EMPTY_BASELINE }) });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes("arrived-later.mjs"), `the failure does not name ${added}:\n${result.message}`);
  assert.equal(result.count, 1, "the read counted the one file, so the empty real tree above is 'nothing there' and not 'nothing read'");
});

test("the same holds for .js and .cjs, which are the other two kinds the rule names", () => {
  for (const added of ["scripts/helper.js", "tool.cjs"]) {
    const result = checkMjsRatchet({ from: copyOfTree({ paths: [...TYPESCRIPT_TREE, added], baselineText: EMPTY_BASELINE }) });
    assert.equal(result.ok, false, `${added} passed against an empty baseline`);
    assert.ok(result.message.includes(added.split("/").pop() as string), result.message);
  }
});

test("a tree that has dropped a listed file passes and says the baseline can be lowered", () => {
  const stale = JSON.stringify({ files: ["converted-since.mjs"], exceptions: [] });
  const result = checkMjsRatchet({ from: copyOfTree({ paths: TYPESCRIPT_TREE, baselineText: stale }) });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /can be lowered/);
});

test("an exception with no `why` fails", () => {
  const withoutWhy = { files: [], exceptions: [{ path: ".pnpmfile.cjs", why: "" }] };
  const result = checkMjsRatchet({ from: copyOfTree({ paths: [...TYPESCRIPT_TREE, ".pnpmfile.cjs"], baselineText: JSON.stringify(withoutWhy) }) });
  assert.equal(result.ok, false);
  assert.match(result.message, /has no `why`/);
});
