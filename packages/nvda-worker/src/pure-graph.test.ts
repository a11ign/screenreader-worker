/**
 * The tests that only need PURE capture logic must not import guidepup — because guidepup throws at import.
 *
 * `@guidepup/guidepup` calls `throw new Error(ERR_NO_AVAILABLE_SUPPORTED_SCREEN_READERS)` at module load
 * where no screen reader exists. CI is Linux, so importing `capture-core.mjs` there fails, and six test files
 * imported it to reach pure helpers (`sweepStepFromSpeech`, `dedupeKey`, `phraseAction`, `crossCheckStructure`,
 * `elementsListRowName`, `failIfScreenReaderIsMute`, `edgeArgs`). Node reports that per FILE as "test failed",
 * which reads like broken logic rather than a missing dependency — the job was red from 1 August, and grew
 * from 2 files to 6 as more tests reached for pure logic through `capture-core`.
 *
 * `capture-pure.mjs` holds those functions now. This test is the acceptance criterion for that split, and it
 * is a STATIC check on purpose: it fails on a Mac, where guidepup imports perfectly well, so nobody has to be
 * on Linux to notice a regression. The one-off proof was stronger — the six files were run with
 * `node_modules/@guidepup` physically moved away, 43 assertions passing — but that is not something a suite
 * can do to itself.
 *
 * The property is about the whole GRAPH, not the direct import: a test could import a pure-looking module that
 * imports `capture-core` two hops down, and the failure would look identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Files that must be usable where no screen reader exists. */
const MUST_BE_PURE = [
  "cross-check.test.ts", "dedupe-key.test.ts", "edge-args.test.ts",
  "read-through.test.ts", "sweep-step.test.ts", "worker-recovery.test.ts",
  "capture-pure.mjs",
];

// `[^;]` and NOT `[^;\n]`: a multi-line `import {\n  a, b\n} from "./x.mjs"` is invisible to a
// newline-excluding pattern, and capture-core has several — the scan saw 4 of its modules instead of 11, so a
// guidepup import written across lines would have passed this guard. Found by the "would it notice" test
// below, which is the only reason it was found at all.
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Every specifier a module imports, static or dynamic. */
function specifiersIn(source: string): string[] {
  return [IMPORT, DYNAMIC].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

/** Every module reachable from `entry` by relative import, plus the bare specifiers encountered. */
function graph(entry: string): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) queue.push(join(dirname(file), specifier));
      else if (!specifier.startsWith("node:")) bare.add(specifier);
    }
  }
  return { files: [...seen], bare };
}

test("the pure capture tests reach no screen-reader dependency", () => {
  for (const name of MUST_BE_PURE) {
    const { files, bare } = graph(join(here, name));
    assert.ok(!bare.has("@guidepup/guidepup"),
      `${name} imports @guidepup/guidepup somewhere in its graph, which THROWS at import where no screen `
      + `reader exists — so this file cannot run in CI. Graph: ${files.map((f) => relative(here, f)).join(", ")}`);
    assert.ok(!files.some((f) => f.endsWith("capture-core.mjs")),
      `${name} reaches capture-core.mjs, which imports guidepup. Import the pure helper from `
      + `capture-pure.mjs instead.`);
  }
});

test("the guard would notice — capture-core itself is NOT pure", () => {
  // Guard the guard. If the scanner stopped matching imports it would report every file clean, which is this
  // project's most repeated failure: a check that passes by examining nothing.
  const { bare, files } = graph(join(here, "capture-core.mjs"));
  assert.ok(bare.has("@guidepup/guidepup"),
    "capture-core imports guidepup directly; a scan that cannot see that cannot see anything");
  assert.ok(files.length > 5, `expected capture-core to reach several modules, found ${files.length}`);
});
