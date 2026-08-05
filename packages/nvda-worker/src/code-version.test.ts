// The worker's code hash is computed on the guest (server.mjs) and on the host (check-worker-code.mjs), and
// the two must cover identical files in an identical order or the comparison is meaningless.
//
// It used to be two literal lists kept in step by a comment saying "must match server.mjs codeVersion()
// exactly", plus a third derived by regex in deploy-worker.mjs. That held until a new worker file was added and
// only one list learned about it: the deploy check then reported a worker as up to date while it was running a
// different version of that file. The first test below was written to catch that.
//
// `worker-files.mjs` now defines the list once and all three import it, so divergence is no longer possible to
// express — a better fix than checking for it. What is still worth asserting is that nobody reintroduces a
// second copy, and that the list actually covers what the guest runs.
//
// Note what may not be imported here: `server.mjs` binds a port on import and `check-worker-code.mjs` runs its
// check on import, so those two are read as TEXT. `worker-files.mjs` is a bare constant and safe to import,
// which is the point of it being its own module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { WORKER_FILES } from "./worker-files.mjs";

const LITERAL_LIST = /for \(const file of \[["']/;

test("there is exactly ONE definition of the worker file list, and one hasher", () => {
  // A reintroduced literal is the regression: two lists that must agree, kept in step by hope.
  for (const path of ["packages/nvda-worker/src/server.mjs", "scripts/check-worker-code.mjs", "scripts/deploy-worker.mjs"]) {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");
    assert.ok(!LITERAL_LIST.test(source),
      `${path} has its own literal worker-file list again. Import WORKER_FILES from worker-files.mjs — a `
      + `second copy is how a file came to deploy without the parity check noticing.`);
    // Either the shared list or the shared hasher — both live in one place, and using either means this
    // file cannot disagree with the other side about contents or order.
    assert.match(source, /worker-files\.mjs|code-version\.mjs/,
      `${path} should get the worker file list, or the hash itself, from the shared module`);
  }
});

test("the hash covers every worker source file the guest runs", () => {
  // A new .mjs in this package that the worker runs but nobody hashes is invisible to
  // `npm run worker:code` — the only check that a deploy actually landed. It must follow imports
  // TRANSITIVELY: capture-faults.mjs is imported by capture-core, not by server.mjs, so a check that only
  // looked at server.mjs's own imports would have missed it and reported a stale guest as fresh.
  const hashed = new Set(WORKER_FILES);
  const seen = new Set<string>();
  const queue = ["server.mjs"];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(resolve(process.cwd(), "packages/nvda-worker/src", file), "utf8");
    for (const [, imported] of source.matchAll(/from "\.\/([\w-]+\.mjs)"/g)) {
      assert.ok(hashed.has(imported), `${file} imports ${imported} but it is not in the code-version hash`);
      queue.push(imported);
    }
  }
  // Guard the guard: if the walk stopped following imports it would pass having examined almost nothing.
  assert.ok(seen.size >= 5, `the import walk only reached ${seen.size} file(s); it is not following imports`);
});

test("the list contains itself, so a change to it is deployed", () => {
  // `worker-files.mjs` is a file the guest runs. If it were absent from its own list, editing it would change
  // no hash — `worker:code` would report every worker current while they served the old list.
  assert.ok(WORKER_FILES.includes("worker-files.mjs"));
  assert.equal(new Set(WORKER_FILES).size, WORKER_FILES.length, "a duplicate would be hashed twice");
});
