import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FILTER = fileURLToPath(new URL("../.github/auto-arm.jq", import.meta.url));

type Pull = { number: number; isDraft: boolean; autoMergeRequest: object | null; labels: { name: string }[] };

const plain = (number: number): Pull => ({ number, isDraft: false, autoMergeRequest: null, labels: [] });

/** The numbers auto-arm.yml would arm out of `pulls`, by running the committed filter through the real `jq`. */
function armed(pulls: Pull[]): number[] {
  const run = spawnSync("jq", ["-r", "-f", FILTER], { input: JSON.stringify(pulls), encoding: "utf8" });
  assert.equal(run.status, 0, `jq failed (is it installed?): ${run.error ?? run.stderr}`);
  return run.stdout.split("\n").filter(Boolean).map(Number);
}

test("only the plain pull request is armed: held, draft and already-armed are each skipped", () => {
  const held: Pull = { ...plain(1), labels: [{ name: "hold:ruling" }] };
  const draft: Pull = { ...plain(2), isDraft: true };
  const alreadyArmed: Pull = { ...plain(3), autoMergeRequest: { mergeMethod: "MERGE" } };
  assert.deepEqual(armed([held, draft, alreadyArmed, plain(4)]), [4]);
});

test("the positive control: each pull request alone is armed only when plain, so no skip is vacuous", () => {
  assert.deepEqual(armed([plain(5)]), [5]);
  assert.deepEqual(armed([{ ...plain(6), labels: [{ name: "session:worker-1" }, { name: "dependencies" }] }]), [6], "other labels do not hold");
  assert.deepEqual(armed([]), []);
});
