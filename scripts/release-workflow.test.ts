import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// THE RELEASE WORKFLOW IS READ AS YAML, never as words (a11ign/a11ign#3714): a comment that explains why there is no `workflow_dispatch`
// would match a search for it, and a key moved under a different parent would pass one. `refusals` returns the name of every property the
// file breaks, so one assertion reads a whole file and a mutation names the property it broke.

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, string>;
  environment?: string;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  steps?: Step[];
};
type Workflow = { on?: Record<string, { branches?: string[] }>; jobs?: Record<string, Job> };

const REUSABLE = /^a11ign\/toolchain\/\.github\/workflows\/release-per-merge\.yml@[0-9a-f]{40}$/;
// What opens a branch or a pull request from a workflow: the action's own inputs, the permission, the CLI, or a push that is not of tags.
const BRANCH_WRITING_RUN = /gh pr create|git (checkout|switch) +-[bBcC]\b|git push(?!.*--tags)/;
const PULL_REQUEST_INPUTS = ["pr-title", "commit-message", "version-script", "branch"];

const jobsOf = (workflow: Workflow): Job[] => Object.values(workflow.jobs ?? {});
const stepsOf = (workflow: Workflow): Step[] => jobsOf(workflow).flatMap((job) => job.steps ?? []);
const callers = (workflow: Workflow): Job[] => jobsOf(workflow).filter((job) => REUSABLE.test(job.uses ?? ""));

function createsABranchOrPullRequest(workflow: Workflow): boolean {
  const asksForOne = stepsOf(workflow).some(
    (step) =>
      /create-pull-request|^changesets\/action/.test(step.uses ?? "") ||
      BRANCH_WRITING_RUN.test(step.run ?? "") ||
      PULL_REQUEST_INPUTS.some((input) => step.with && input in step.with),
  );
  return asksForOne || jobsOf(workflow).some((job) => job.permissions?.["pull-requests"] === "write");
}

const PROPERTIES: { name: string; holds: (workflow: Workflow, text: string) => boolean }[] = [
  { name: "calls the reusable per-merge workflow, pinned by full sha", holds: (w) => callers(w).length > 0 },
  { name: "has no changesets/action step", holds: (w) => !stepsOf(w).some((step) => (step.uses ?? "").startsWith("changesets/action")) },
  { name: "has no job that creates a branch or a pull request", holds: (w) => !createsABranchOrPullRequest(w) },
  { name: "does not use A11IGN_BOT_TOKEN", holds: (w) => !JSON.stringify(w).includes("A11IGN_BOT_TOKEN") },
  { name: "the calling job holds id-token: write", holds: (w) => callers(w).some((job) => job.permissions?.["id-token"] === "write") },
  { name: "the calling job publishes to the registry (kind: npm)", holds: (w) => callers(w).some((job) => job.with?.kind === "npm") },
  {
    name: "the calling job never cancels a release in flight",
    holds: (w) => callers(w).some((job) => job.concurrency?.["cancel-in-progress"] === false),
  },
  { name: "has no workflow_dispatch", holds: (w) => !("workflow_dispatch" in (w.on ?? {})) },
  {
    name: "triggers on a push to main and nothing else",
    holds: (w) => JSON.stringify(Object.keys(w.on ?? {})) === '["push"]' && JSON.stringify(w.on?.push?.branches) === '["main"]',
  },
];

export function refusals(text: string): string[] {
  const workflow = parse(text) as Workflow;
  return PROPERTIES.filter((property) => !property.holds(workflow, text)).map((property) => property.name);
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const release = read("../.github/workflows/release.yml");
// The workflow this row replaced, kept as it was at the branch point: the positive control, which must be REFUSED.
const before = read("./fixtures/release-before-3714.yml");

test("release.yml breaks none of the properties", () => {
  assert.deepEqual(refusals(release), []);
});

test("CONTROL: the version-pull-request workflow it replaced is refused for each property it breaks", () => {
  assert.deepEqual(refusals(before), [
    "calls the reusable per-merge workflow, pinned by full sha",
    "has no changesets/action step",
    "has no job that creates a branch or a pull request",
    "does not use A11IGN_BOT_TOKEN",
    "the calling job holds id-token: write",
    "the calling job publishes to the registry (kind: npm)",
    "the calling job never cancels a release in flight",
  ]);
});

// A passing file is read against failing ones: each mutation breaks ONE property of a file that holds them all, and only that one is named.
function mutated(edit: (workflow: Workflow) => void): string[] {
  const workflow = parse(release) as Workflow;
  assert.equal(callers(workflow).length, 1, "positive control: the file this mutates has its calling job");
  edit(workflow);
  return refusals(JSON.stringify(workflow));
}

const MUTATIONS: { breaks: string; edit: (workflow: Workflow) => void }[] = [
  {
    breaks: "calls the reusable per-merge workflow, pinned by full sha",
    edit: (w) => void (callers(w)[0].uses = "a11ign/toolchain/.github/workflows/release-per-merge.yml@main"),
  },
  {
    breaks: "has no changesets/action step",
    edit: (w) => void (w.jobs!.version = { steps: [{ uses: "changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51" }] }),
  },
  {
    breaks: "has no job that creates a branch or a pull request",
    edit: (w) => void (w.jobs!.version = { permissions: { "pull-requests": "write" } }),
  },
  {
    breaks: "has no job that creates a branch or a pull request",
    edit: (w) => void (w.jobs!.version = { steps: [{ run: "git push origin HEAD:refs/heads/release" }] }),
  },
  {
    breaks: "does not use A11IGN_BOT_TOKEN",
    edit: (w) => void (callers(w)[0].with = { ...callers(w)[0].with, token: "${{ secrets.A11IGN_BOT_TOKEN }}" }),
  },
  { breaks: "the calling job holds id-token: write", edit: (w) => void delete callers(w)[0].permissions!["id-token"] },
  { breaks: "the calling job publishes to the registry (kind: npm)", edit: (w) => void (callers(w)[0].with!.kind = "tag") },
  { breaks: "the calling job never cancels a release in flight", edit: (w) => void (callers(w)[0].concurrency!["cancel-in-progress"] = true) },
  { breaks: "has no workflow_dispatch", edit: (w) => void (w.on!.workflow_dispatch = {}) },
  { breaks: "triggers on a push to main and nothing else", edit: (w) => void (w.on!.push!.branches = ["main", "agent/x"]) },
];

for (const { breaks, edit } of MUTATIONS) {
  test(`MUTATION: ${breaks}`, () => {
    assert.ok(breaks, "positive control: a mutation names what it breaks");
    assert.ok(refusals(release).length === 0, "positive control: the file it mutates passes");
    assert.ok(mutated(edit).includes(breaks), "the mutation is refused for the property it broke");
  });
}

test("a mutation that breaks nothing is not counted as a refusal (the marker does not complain of an absent fault)", () => {
  assert.deepEqual(mutated(() => undefined), []);
});

test("the tags a release pushes are not a branch: `git push --tags` is allowed", () => {
  assert.equal(BRANCH_WRITING_RUN.test("git push origin --tags"), false);
  assert.equal(BRANCH_WRITING_RUN.test("git push origin HEAD:main"), true);
});

// WHERE THE `environment` LIVES: GitHub refuses `environment:` on a job that calls a reusable workflow, so the environment `npm-publish`
// (limited to `main`, and the one the npm trusted-publisher entry names) is on the publishing job of the CALLED file, which is in
// `a11ign/toolchain` at the sha the caller pins and is read there by that repository's own test. THIS repository can only assert its half:
// the calling job holds `id-token: write`, because a called workflow can keep or reduce a permission and never gain one.
