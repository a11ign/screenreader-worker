import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Comments are dropped first: the file explains WHY it has no `workflow_dispatch`, in words that would match it.
export function codeOf(workflow: string): string {
  return workflow
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

const release = codeOf(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));

test("no trigger can publish from a branch: release.yml has no workflow_dispatch", () => {
  assert.match(release, /^on:\n/m, "positive control: the trigger block is found");
  assert.doesNotMatch(release, /workflow_dispatch/);
});

test("the publish job runs in the environment limited to main, which the trusted-publisher binding names", () => {
  const publish = release.slice(release.indexOf("\n  publish:\n"));
  assert.match(publish, /^ {6}id-token: write$/m, "positive control: this is the job that holds the OIDC permission");
  assert.match(publish, /^ {4}environment: npm-publish$/m);
});

test("codeOf drops a comment that mentions the trigger", () => {
  assert.doesNotMatch(codeOf("# workflow_dispatch\non:\n  push:\n"), /workflow_dispatch/);
});
