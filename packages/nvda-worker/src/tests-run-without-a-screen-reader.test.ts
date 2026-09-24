import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { filesUnder } from "../../guards/src/files-under.mjs";

/**
 * NO TEST MAY REACH GUIDEPUP — known-gaps §12, and this is its SECOND occurrence.
 *
 * `@guidepup/guidepup`'s index constructs a `ScreenReader` at MODULE SCOPE, and the constructor throws
 * `No available supported screen readers` on a host without one. So merely importing a module that
 * imports it fails on a Linux CI runner, before a single assertion runs.
 *
 * It is INVISIBLE ON MACOS, because VoiceOver satisfies guidepup's availability check. The suite passes
 * locally, the pre-push hook passes, and the only environment that can see it is the one nobody watches —
 * `ci.yml` (successor to `lint.yml`) runs on the PULL REQUEST ONLY (chairman's direction, 2026-09-06: a
 * check that runs after a merge cannot stop it, so there is no push trigger at all), so a bare branch push
 * alone never fires it.
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

/**
 * `filesUnder` REPLACES the private `sourceFiles` this file carried (#2255): #2171 exported the walker
 * because a private one cannot be called, so no test can assert anything about it, and this was the fifth.
 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git", "runs"]);

/** How a walk lists a tree; a parameter so a test can make a file vanish between listing and reading. */
type Lister = typeof filesUnder;

const sourceFiles = (dir: string, list: Lister = filesUnder): string[] => list(dir, {
  skipDirectory: (name) => SKIPPED_DIRECTORIES.has(name),
  keepFile: (name) => /\.(mjs|ts)$/.test(name),
  // Another test may plant a temp directory in `packages/` and remove it while this walk runs
  // (`corpus-backup.test.ts`, #1919/#2255). No placement dodges a walker that walks `packages/` entire.
  skipVanishedDirectories: true,
});

/**
 * Read a listed file, or null if it vanished after it was listed.
 *
 * ONLY `ENOENT` is tolerated, by name. A file that was listed and is gone is a concurrent test's temp copy
 * being removed — not this walk's business, and not a guidepup import. Any other error (`EACCES`, `EISDIR`)
 * is an unreadable SOURCE file, which this walk is one of the few things positioned to see, so it rethrows.
 * Tolerating every error would let unreadable files empty the population silently; the anti-vacuity floor
 * in `assertSomethingIsPoisoned` is what catches the case where tolerance emptied it anyway.
 */
function readListedFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
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

/** Files under `root` whose import graph reaches guidepup, computed to a fixed point. */
function poisonedFiles(root: string, list: Lister = filesUnder): Set<string> {
  const poisoned = new Set<string>();
  const direct = new Map<string, string[]>();
  for (const file of sourceFiles(root, list)) {
    const text = readListedFile(file);
    if (text === null) continue;
    if (importsOf(text).includes(POISON)) poisoned.add(file);
    direct.set(file, importsOf(text).map((s) => resolveLocal(file, s)).filter((x): x is string => !!x));
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, deps] of direct) {
      if (poisoned.has(file)) continue;
      if (deps.some((d) => poisoned.has(d))) { poisoned.add(file); changed = true; }
    }
  }
  return poisoned;
}

/**
 * ANTI-VACUITY: guidepup IS imported somewhere on purpose. If nothing is poisoned the walker is broken,
 * and this test would pass having proved nothing — the exact shape it exists to catch. It also catches a
 * tolerant read that skipped every file.
 */
function assertSomethingIsPoisoned(poisoned: Set<string>): void {
  assert.ok(poisoned.size > 0,
    "no file was found importing guidepup at all; the import walker is broken, not the tree clean");
}

const testFilesIn = (poisoned: Set<string>, root: string): string[] =>
  [...poisoned].filter((f) => /\.test\.[cm]?ts$/.test(f)).map((f) => f.slice(root.length + 1)).sort();

test("no test file's import graph reaches guidepup", () => {
  const poisoned = poisonedFiles(join(ROOT, "packages"));
  assertSomethingIsPoisoned(poisoned);

  const offenders = testFilesIn(poisoned, ROOT);
  assert.deepEqual(offenders, [], "these tests import a module that reaches guidepup, so they throw at "
    + "IMPORT on any host without a screen reader — invisible on macOS, red on CI:\n  "
    + offenders.join("\n  "));
});

// THE RACE THAT WENT RED ON #2242 AT f844104d3 (#2255), ON A REAL FILESYSTEM. The lister below lists the
// tree for real and THEN deletes a file, so the walk is handed a path that no longer exists — the exact
// window a concurrent test's `finally { rmSync }` lands in. A tree with no temp directory in it proves
// nothing; that is what every passing run already was.
function withTree(files: Record<string, string>, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "no-screen-reader-walk-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const listThenDelete = (victims: string[]): Lister => (root, choices) => {
  const listed = filesUnder(root, choices);
  for (const victim of victims) rmSync(join(root, victim), { force: true });
  return listed;
};

const IMPORTS_GUIDEPUP = `import { x } from "${POISON}";\n`;

test("a file that vanishes between listing and reading does not crash the walk or hide the rest", () => {
  withTree({
    "lib/poisoned.mjs": IMPORTS_GUIDEPUP,
    "lib/holds.test.ts": 'import { x } from "./poisoned.mjs";\n',
    "lib/temp-copy.mjs": "export {};\n",
  }, (root) => {
    const poisoned = poisonedFiles(root, listThenDelete(["lib/temp-copy.mjs"]));

    assertSomethingIsPoisoned(poisoned);
    assert.deepEqual(testFilesIn(poisoned, root), ["lib/holds.test.ts"],
      "the survivors are still walked, so a real offender is still reported beside a vanished sibling");
  });
});

test("THE FLOOR STILL FIRES when every listed file vanished", () => {
  // Tolerance must not be able to empty the population silently.
  withTree({ "lib/poisoned.mjs": IMPORTS_GUIDEPUP }, (root) => {
    const poisoned = poisonedFiles(root, listThenDelete(["lib/poisoned.mjs"]));

    assert.throws(() => assertSomethingIsPoisoned(poisoned), /walker is broken/);
  });
});

test("only ENOENT is tolerated: a listed path that cannot be READ for another reason still throws", () => {
  // A directory listed as a file reads as EISDIR — an unreadable source, not a race.
  withTree({ "lib/a.mjs": "export {};\n" }, (root) => {
    const lists: Lister = () => [join(root, "lib")];

    assert.throws(() => poisonedFiles(root, lists), /EISDIR/);
  });
});
