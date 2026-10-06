// @ts-check
/**
 * Bakes the code hash of `src` into the built `dist/code-version.mjs`, after `rslib build` (a11ign/a11ign#3740, orchestrator
 * Ruling 2 on #3552).
 *
 * WHY. The worker a guest runs is raw `src/*.mjs` (ADR 0031), and `/health.code` is `codeVersion()` over `WORKER_FILES` there. The
 * built package cannot compute that itself: its `workerSourceDir()` is `dist/`, which holds none of those files (Rspack names the
 * chunks `src_capture-core_mjs.mjs`), so `codeVersion()` with no argument threw ENOENT and a consumer that wants to know what a worker
 * SHOULD be serving, `screenreader-fleet`'s `expectedWorkerCode`, had nothing to ask.
 *
 * WHY HERE AND NOT IN `src/code-version.mjs`. That file is in `WORKER_FILES`, so editing it moves `/health.code` on every worker in the
 * fleet. This script is not in the list, so it can run for the whole package without touching the thing it reports. The hash is taken
 * with the ONE hasher, `src/code-version.mjs` itself, never a second implementation.
 *
 * WHAT IT CHANGES. Only the DEFAULT of `codeVersion(dir)`: with no argument it returns the hash of the `src` this package was built
 * from; with a directory it hashes that directory exactly as before, which is how the fleet's deploy and a guest use it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = resolve(import.meta.dirname, "..");

// The two spellings Rslib emits today, one in the module and one in the declaration. Each must be found exactly once: a build that
// words either differently has to fail here, where it is read, and not ship a package whose `codeVersion()` still throws.
const MODULE_DEFAULT = "function codeVersion(dir = workerSourceDir()) {";
const DECLARATION_DEFAULT = "(defaults to this module's own directory)";

/**
 * @param {string} text
 * @param {string} marker
 * @param {string} file
 */
function assertFoundOnce(text, marker, file) {
  const count = text.split(marker).length - 1;
  if (count !== 1) {
    throw new Error(`${file} holds ${count} of \`${marker}\`, expected exactly 1: Rslib's output changed shape, so ${import.meta.filename} `
      + "can no longer bake the source hash into it. Fix the marker; do not skip the step.");
  }
}

/**
 * The built module with `codeVersion()` returning `hash` when it is given no directory.
 *
 * @param {string} moduleText
 * @param {string} hash
 */
export function bakeModule(moduleText, hash) {
  assertFoundOnce(moduleText, MODULE_DEFAULT, "dist/code-version.mjs");
  return moduleText.replace(MODULE_DEFAULT, () =>
    `const SOURCE_CODE_VERSION = ${JSON.stringify(hash)};\nfunction codeVersion(dir) {\n    if (dir === undefined) return SOURCE_CODE_VERSION;`);
}

/**
 * The declaration with its description telling the truth about the default.
 *
 * @param {string} declarationText
 */
export function bakeDeclaration(declarationText) {
  assertFoundOnce(declarationText, DECLARATION_DEFAULT, "dist/code-version.d.mts");
  return declarationText.replace(DECLARATION_DEFAULT, () => "(with no argument: the hash of the `src` this package was built from)");
}

/** The hash of `src/`, by `src/code-version.mjs`'s own `codeVersion`. */
async function sourceCodeVersion() {
  const srcDir = join(packageDir, "src");
  const hasher = await import(pathToFileURL(join(srcDir, "code-version.mjs")).href);
  return hasher.codeVersion(srcDir);
}

/** Rewrites `dist/code-version.mjs` and its declaration in place. */
async function main() {
  const modulePath = join(packageDir, "dist", "code-version.mjs");
  const declarationPath = join(packageDir, "dist", "code-version.d.mts");
  const hash = await sourceCodeVersion();
  writeFileSync(modulePath, bakeModule(readFileSync(modulePath, "utf8"), hash));
  writeFileSync(declarationPath, bakeDeclaration(readFileSync(declarationPath, "utf8")));
  process.stdout.write(`dist/code-version.mjs: codeVersion() with no argument is ${hash}, the hash of src/\n`);
}

if (import.meta.filename === process.argv[1]) await main();
