// `browserVersion` is a capture cache key, and the worker memoised it for the life of the process on the
// stated assumption that "updating Edge or NVDA restarts this process". Nothing makes that true: Edge's
// updater replaces files on disk and the worker is a separate scheduled task.
//
// Measured on a11y-worker-2 before the fix: /health reported Edge 151.0.4129.93 with an uptime of 5 days
// while msedge.exe on disk was 151.0.4129.101, written four days INTO that uptime. So every capture taken
// after the update was stamped with a browser version it was not captured under, and shared a cache key
// with evidence from a different browser build -- the precise failure the key exists to prevent.
//
// Tested here rather than on a guest because a DEPLOY WOULD HAVE HIDDEN IT: restarting the worker rebuilds
// the memo, so a correct version after a deploy proves the restart worked and vouches for nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fileProductVersion } from "./server.mjs";

const EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/** A stat that reports whatever the test currently says the file is. */
function fakeFile(initial: { mtimeMs: number; size: number }) {
  const state = { ...initial };
  return {
    state,
    stat: (path: string) => {
      if (path !== EXE) throw new Error("ENOENT");
      return { mtimeMs: state.mtimeMs, size: state.size };
    },
  };
}

test("an unchanged binary is read once, however often it is asked for", () => {
  const file = fakeFile({ mtimeMs: 1000, size: 500 });
  let reads = 0;
  const read = () => { reads += 1; return "151.0.4129.93"; };

  for (let i = 0; i < 20; i += 1) {
    assert.equal(fileProductVersion(EXE, { stat: file.stat, read }), "151.0.4129.93");
  }
  // The whole reason the memo exists: /health is polled, and the read is a blocking PowerShell child.
  assert.equal(reads, 1, "the memo must still keep PowerShell off the polled path");
});

test("a REPLACED binary is re-read, which is the defect this fixes", () => {
  const file = fakeFile({ mtimeMs: 2000, size: 500 });
  const versions = ["151.0.4129.93", "151.0.4129.101"];
  let reads = 0;
  const read = () => versions[Math.min(reads++, versions.length - 1)];

  assert.equal(fileProductVersion(EXE, { stat: file.stat, read }), "151.0.4129.93");

  // Edge updates under the running worker. Before the fix this returned .93 forever.
  file.state.mtimeMs = 3000;
  assert.equal(fileProductVersion(EXE, { stat: file.stat, read }), "151.0.4129.101",
    "a new binary must produce a new version, or the cache key describes a browser we are not running");
  assert.equal(reads, 2);

  // And then memoises again at the new identity, rather than re-reading on every poll.
  for (let i = 0; i < 5; i += 1) fileProductVersion(EXE, { stat: file.stat, read });
  assert.equal(reads, 2);
});

test("a transient read failure does not become permanent", () => {
  // `bootConstant` already had this rule and it is worth keeping: caching \"unknown\" would freeze a momentary
  // PowerShell timeout into the provenance of every later capture.
  const file = fakeFile({ mtimeMs: 4000, size: 500 });
  const answers = ["unknown", "151.0.4129.101"];
  let reads = 0;
  const read = () => answers[Math.min(reads++, answers.length - 1)];

  assert.equal(fileProductVersion(EXE, { stat: file.stat, read }), "unknown");
  assert.equal(fileProductVersion(EXE, { stat: file.stat, read }), "151.0.4129.101");
});

test("an absent file is unknown rather than a throw", () => {
  const file = fakeFile({ mtimeMs: 5000, size: 500 });
  assert.equal(fileProductVersion("C:\\nope.exe", { stat: file.stat, read: () => "x" }), "unknown");
});
