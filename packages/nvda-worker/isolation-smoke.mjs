// Run by `scripts/isolation-gate.mjs` from a throwaway directory OUTSIDE this repository, against the
// installed tarball.
//
// The hard part is that this package cannot be exercised without Windows, NVDA and an interactive desktop, and
// merely IMPORTING it needs a screen reader: `@guidepup/guidepup` throws at import where none exists. So the
// checks are ordered by what they require, and the ones that matter most need nothing at all.
//
// Tarball completeness is checked from DISK rather than by importing, because `codeVersion()` — which is the
// natural completeness check, since it hashes all 14 worker files — is only reachable through an import that
// pulls in guidepup.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@a11y-witness/nvda-worker/package.json");
const root = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Every file the worker's own code hash covers must be in the tarball. This is the completeness check: a
// `files` allow-list drops assets silently, and a worker missing one module fails at runtime on the guest —
// the most expensive place to find out.
const { WORKER_FILES } = await import(`file://${join(root, "src/worker-files.mjs")}`);
assert.ok(WORKER_FILES.length >= 10, `expected the full worker file list, got ${WORKER_FILES.length}`);
for (const file of WORKER_FILES) {
  assert.ok(existsSync(join(root, "src", file)), `${file} is in the code hash but missing from the tarball`);
}

// The Windows launchers are payload an allow-list loses exactly as easily as a `.py` or a `.safetensors`.
for (const cmd of ["run-server.cmd", "run-capture.cmd", "run-capture-check.cmd"]) {
  assert.ok(existsSync(join(root, "src", cmd)), `${cmd} is missing from the tarball`);
}

// The bin npm links as `a11y-nvda-worker`.
assert.ok(existsSync(join(root, manifest.bin["a11y-nvda-worker"])), "the worker bin is missing");

// Tests must NOT ship. They are excluded by the `files` allow-list, and a consumer's node_modules is the wrong
// place for them.
const shippedTests = readdirSync(join(root, "src")).filter((f) => f.endsWith(".test.ts"));
assert.deepEqual(shippedTests, [], `tests were shipped: ${shippedTests.join(", ")}`);

// guidepup must be pinned EXACTLY. It parses NVDA's speech before this project sees it, so its version is
// evidence — 0.29.2 -> 0.31.0 removed an intermittent U+FFFC from form-field announcements. A caret range
// would let a consumer's `npm update` silently change what a capture says.
assert.equal(manifest.dependencies["@guidepup/guidepup"], "0.31.0",
  "guidepup must be pinned exactly, not with a caret range");

// Last, and only if this machine has a screen reader at all: the actual entry point. A failure here on a
// machine with no screen reader is guidepup refusing to load, NOT a packaging defect — so it is reported as
// what it is rather than passed over in silence.
let entry;
try {
  entry = await import("@a11y-witness/nvda-worker");
} catch (error) {
  if (/No available supported screen readers/.test(String(error))) {
    console.error("cannot verify the entry point here: this machine has no screen reader, so guidepup refuses "
      + "to import. The tarball checks above all passed. Run the gate on macOS or Windows.");
    process.exit(3);
  }
  throw error;
}

assert.equal(typeof entry.captureWithNvda, "function");
assert.equal(typeof entry.codeVersion, "function");
assert.equal(typeof entry.CAPTURE_PROTOCOL_VERSION, "number");
// The hash proves every file it names was readable from the installed location, from any cwd.
assert.match(entry.codeVersion(), /^[0-9a-f]{16}$/);

console.log(`@a11y-witness/nvda-worker works when installed: ${WORKER_FILES.length} worker files present, `
  + `protocol v${entry.CAPTURE_PROTOCOL_VERSION}, code ${entry.codeVersion()}`);
