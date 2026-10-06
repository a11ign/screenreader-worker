import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// THE BUILT PACKAGE IS PINNED, because every other test in this repository reads `src` (a11ign/a11ign#3734, follow-up of #3552).
//
// `@a11ign/screenreader-worker` ships `dist`, built by Rslib, and the first build of it had a defect that no test of `src` could see:
// Rspack rewrote `new URL("./", import.meta.url)` in `code-version.mjs` into `./static/assets/index.mjs`, so `workerSourceDir()` returned a
// FILE. It was found by reading the output by hand. CI runs `pnpm run build` before `pnpm test`, so a test that reads `dist` is red in CI
// the next time a build breaks one of these.
//
// NOT HERE: the deploy, and a consumer's strict `tsc` over the `.d.mts` files, which needs a network install.

const packageDir = resolve(import.meta.dirname, "../packages/nvda-worker");
const distDir = join(packageDir, "dist");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { exports: unknown; bin: unknown };

// A skip that fires always is a check that never runs, so an absent `dist` FAILS, and says what to run.
function requireBuilt(): void {
  assert.ok(existsSync(distDir), `${distDir} does not exist: run \`pnpm run build\` first (CI does, before \`pnpm test\`)`);
}

// Every string in a value that `exports` or `bin` hangs a file on: a condition object (`types`, `default`) nests, `./package.json` is bare.
function targetsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(targetsOf);
  return [];
}

function missingTargets(dir: string, targets: string[]): string[] {
  return targets.filter((target) => !existsSync(join(dir, target)));
}

const exportTargets = targetsOf(manifest.exports);
const binTargets = targetsOf(manifest.bin);

test("the guard names a target that is missing (positive control for the two emptiness assertions below)", () => {
  assert.deepEqual(missingTargets(packageDir, ["./package.json", "./dist/no-such-file.mjs"]), ["./dist/no-such-file.mjs"]);
  assert.ok(exportTargets.includes("./dist/index.mjs") && exportTargets.includes("./dist/index.d.mts"), "`exports` names `.` for both conditions");
  assert.deepEqual(binTargets, ["./dist/server.mjs"], "`bin` names the server, which is not an `exports` key");
});

test("every file `exports` names, for `default` and for `types`, is in the built package", () => {
  requireBuilt();
  assert.deepEqual(missingTargets(packageDir, exportTargets), []);
});

test("every file `bin` names is in the built package", () => {
  requireBuilt();
  assert.deepEqual(missingTargets(packageDir, binTargets), []);
});

test("Rspack left no `dist/static`, which is where it copies an asset it has taken `new URL(...)` for", () => {
  requireBuilt();
  assert.equal(existsSync(join(distDir, "static")), false, "`dist/static` exists: `parser: { url: false }` is gone from rslib.config.mjs");
});

test("`workerSourceDir()` in the built `code-version.mjs` is a directory, and `dist` itself", async () => {
  requireBuilt();
  const { workerSourceDir } = await import(/* webpackIgnore: true */ pathToFileURL(join(distDir, "code-version.mjs")).href);
  const dir: string = workerSourceDir();
  assert.ok(existsSync(dir) && statSync(dir).isDirectory(), `${dir} is not a directory`);
  assert.equal(resolve(dir), distDir);
});
