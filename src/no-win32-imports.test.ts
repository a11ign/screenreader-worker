/**
 * The worker's package index must not load the capture driver at import time (#1772).
 *
 * `@guidepup/guidepup` constructs a `ScreenReader` at module scope and throws where no screen reader exists, which is every
 * Linux and macOS host. Importing this package BY NAME reaches that throw unless every static import on the way is clean, and
 * `capture-setup.ts` and `capture-probes.ts` used to hold one at the top of the file. Both now reach the driver through a
 * dynamic `await import()` inside the function that drives NVDA, so the index can be imported on any host.
 *
 * This walks the STATIC import graph, because a runtime import of the index on Linux would throw for the very reason this
 * test exists to catch and would say nothing about which file caused it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/** The module whose mere import throws where there is no screen reader. */
const POISON = "@guidepup/guidepup";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const WORKER_INDEX = "index.ts";

/** Reads a file as text by its path relative to `src/`, or null when there is no such file. */
type Reader = (file: string) => string | null;

const fromDisk: Reader = (file) => (existsSync(join(SRC, file)) ? readFileSync(join(SRC, file), "utf8") : null);

/** A reader over an in-memory module map, so the walker can be shown to find a chain it was not written for. */
const fixture = (files: Record<string, string>): Reader => (file) => files[file] ?? null;

/**
 * STATIC imports only: `import x from "y"` and `export ... from "y"`, plus the bare `import "y"` form.
 *
 * A dynamic `await import()` is the remedy and must not be flagged, so the pattern requires `from` or a line that opens with
 * `import` and a quote. A line starting `(` or `await` is a dynamic import and matches neither.
 */
function staticImports(text: string): string[] {
  const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^;\n]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  return [...specifiers, ...[...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((m) => m[1])];
}

/** Resolves a relative specifier to a file under `src/`, or null when it names none. `.js` in a TypeScript import means the `.ts` beside it. */
function resolveLocal(fromFile: string, specifier: string, read: Reader): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = posix.join(dirname(fromFile), specifier);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, posix.join(base, "index.ts")]) {
    if (read(candidate) !== null) return candidate;
  }
  return null;
}

/**
 * Every file reachable from `entry` by static imports, each with the chain that reached it, and the chain to the poison
 * when one of them imports it statically. `reached` is what makes a null `driver` mean something: a walk that read nothing
 * also returns null.
 */
function walk(entry: string, read: Reader) {
  const chains = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  let driver: string[] | null = null;
  for (const file of queue) {
    for (const specifier of staticImports(read(file) ?? "")) {
      if (specifier === POISON) driver ??= [...chains.get(file)!, POISON];
      const next = resolveLocal(file, specifier, read);
      if (next && !chains.has(next)) {
        chains.set(next, [...chains.get(file)!, next]);
        queue.push(next);
      }
    }
  }
  return { reached: chains, driver };
}

test("the poison really is reachable from a real file, or this guard proves nothing", () => {
  // The index cannot serve as this proof: it is clean on purpose. So the walker is shown a planted chain, standing in for a
  // real file that imports the driver, and a dynamic import beside it, which the walker must NOT flag because it is the remedy.
  const chained = walk("entry.ts", fixture({
    "entry.ts": 'export { nvda } from "./middle.ts";',
    "middle.ts": `import { nvda } from "${POISON}";\nexport { nvda };`,
  }));
  assert.deepEqual(chained.driver, ["entry.ts", "middle.ts", POISON], "the walker no longer finds the poison through a local import");

  const dynamic = walk("lazy.ts", fixture({
    "lazy.ts": `export async function drive() {\n  return (await import("${POISON}")).nvda;\n}\n`,
  }));
  assert.equal(dynamic.driver, null, "a dynamic import of the driver is flagged, but it is the remedy and must pass");
});

test("the worker package's own index no longer reaches the driver statically -- guidepup is a lazy import now (#1772)", () => {
  // `capture-setup.ts` and `capture-probes.ts` used to `import … from "@guidepup/guidepup"` at the top of the file, so merely
  // importing the package by name crashed on any host without a screen reader, even over the `--worker` HTTP path, which never
  // drives NVDA locally. Both now reach the driver through `ensureGuidepup`, so this walker cannot see an edge from the index to
  // the driver. That absence IS the fix; if this finds a chain again, guidepup has gone back to loading at import time.
  const { reached, driver } = walk(WORKER_INDEX, fromDisk);
  assert.ok(reached.has("capture-core.ts"), "the walk from the index never reached capture-core.ts, so a null below proves nothing");
  assert.equal(driver, null, `${WORKER_INDEX} reaches ${POISON} statically via ${driver?.join(" -> ")}; the guidepup import in `
    + "capture-setup.ts/capture-probes.ts must stay a dynamic import() inside the function that needs it.");
});
