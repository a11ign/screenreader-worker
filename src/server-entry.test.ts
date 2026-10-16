/**
 * The worker's entry test must answer "was I run" the same way whether the launcher reached the server through a
 * symlink, a directory link (a junction on Windows) or the real path. On `main` the server compared
 * `import.meta.url` (a real path) with `process.argv[1]` (as given), so a linked path was "not main": the server
 * never listened and the process exited 0 with no output. Fixtures are real files and real links in a temp dir.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isEntryPoint } from "./is-entry-point.ts";

let dir: string;
let server: string;
let metaUrl: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "server-entry-"));
  // `server.ts` is reached by its real path (node resolves `import.meta.url` that way), so the fixture's URL is
  // the realpath too. On macOS the temp dir is itself a link, which is why this is not `pathToFileURL(server)`.
  const realDir = realpathSync(dir);
  mkdirSync(join(realDir, "pkg"));
  server = join(realDir, "pkg", "server.mjs");
  writeFileSync(server, "");
  writeFileSync(join(realDir, "other.mjs"), "");
  metaUrl = pathToFileURL(server).href;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("(a) argv[1] is a file symlink to the server: it is the entry", () => {
  const link = join(dir, "server-link.mjs");
  symlinkSync(server, link);
  assert.equal(isEntryPoint(metaUrl, link), true);
});

test("(a2) argv[1] reaches the server through a directory link (the junction shape): it is the entry", () => {
  const link = join(dir, "pkg-link");
  symlinkSync(join(dir, "pkg"), link, "dir");
  assert.equal(isEntryPoint(metaUrl, join(link, "server.mjs")), true);
});

test("(b) argv[1] is the real path: it is the entry, as it always was", () => {
  assert.equal(isEntryPoint(metaUrl, server), true);
});

test("(c) argv[1] is a different file: a library import stays silent", () => {
  assert.equal(isEntryPoint(metaUrl, join(dir, "other.mjs")), false);
});

test("(d) argv[1] is undefined or empty: false, and no throw", () => {
  assert.equal(isEntryPoint(metaUrl, undefined), false);
  assert.equal(isEntryPoint(metaUrl, ""), false);
});

test("(e) argv[1] names a path that does not exist: false, and no throw", () => {
  assert.equal(isEntryPoint(metaUrl, join(dir, "no-such-file.mjs")), false);
});
