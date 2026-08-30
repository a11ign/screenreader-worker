import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * NO TEST MAY REACH GUIDEPUP — known-gaps §12, and this is its SECOND occurrence.
 *
 * `@guidepup/guidepup`'s index constructs a `ScreenReader` at MODULE SCOPE, and the constructor throws
 * `No available supported screen readers` on a host without one. So merely importing a module that
 * imports it fails on a Linux CI runner, before a single assertion runs.
 *
 * It is INVISIBLE ON MACOS, because VoiceOver satisfies guidepup's availability check. The suite passes
 * locally, the pre-push hook passes, and the only environment that can see it is the one nobody watches —
 * `lint.yml` runs on pushes to `main` and on pull requests, so branch work never fires it.
 *
 * WHY A SECOND GUARD. `no-win32-imports.test.ts` was written for exactly this and cannot see it: its
 * `isSource` is `!/\.test\.ts$/`, so it examines SOURCE files for poisoned imports and never the test
 * files that import poisoned modules. Four did — `browser-error-page`, `focus-order-cycle`,
 * `landed-on-page`, and `file-version-memo` via `server.mjs` — and all four went red the moment `main`
 * got far enough to run them. The first fix also framed the problem as importing the worker BY PACKAGE
 * NAME; a RELATIVE import of `capture-core.mjs` is poisoned just the same, which is what these four did.
 *
 * The remedy is `capture-pure.mjs` and `file-version.mjs`: the pure helpers live there, and the modules
 * that need a screen reader re-export them so their own callers are unchanged.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const POISON = "@guidepup/guidepup";

/** Modules that legitimately import guidepup. Reaching one of these from a test is the defect. */
const POISONED = new Set<string>();

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git", "runs"].includes(entry.name)) continue;
      sourceFiles(path, out);
    } else if (/\.(mjs|ts)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Resolve a relative specifier to a file on disk, or null for a bare package specifier. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".mjs")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch { /* try the next spelling */ }
  }
  return null;
}

const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^"';]*from\s+["']([^"']+)["']/g)].map((m) => m[1]);

/** Files whose import graph reaches guidepup, computed to a fixed point. */
function poisonedFiles(): Set<string> {
  const files = sourceFiles(join(ROOT, "packages"));
  const direct = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (importsOf(text).includes(POISON)) POISONED.add(file);
    direct.set(file, importsOf(text).map((s) => resolveLocal(file, s)).filter((x): x is string => !!x));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, deps] of direct) {
      if (POISONED.has(file)) continue;
      if (deps.some((d) => POISONED.has(d))) { POISONED.add(file); changed = true; }
    }
  }
  return POISONED;
}

test("no test file's import graph reaches guidepup", () => {
  const poisoned = poisonedFiles();
  // ANTI-VACUITY: guidepup IS imported somewhere on purpose. If nothing is poisoned the walker is broken,
  // and this test would pass having proved nothing — the exact shape it exists to catch.
  assert.ok(poisoned.size > 0,
    "no file was found importing guidepup at all; the import walker is broken, not the tree clean");

  const offenders = [...poisoned]
    .filter((f) => /\.test\.[cm]?ts$/.test(f))
    .map((f) => f.slice(ROOT.length + 1))
    .sort();
  assert.deepEqual(offenders, [], "these tests import a module that reaches guidepup, so they throw at "
    + "IMPORT on any host without a screen reader — invisible on macOS, red on CI:\n  "
    + offenders.join("\n  "));
});
