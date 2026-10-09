// no-token: none -- reads two files of this repository and matches the policy's patterns against claim values measured on a11ign/a11ign#4191.
/**
 * a11ign/a11ign#4199: `auto-arm.yml` ARMS WITH AN OCTO STS TOKEN, AND THE POLICY BEHIND IT HOLDS ONLY WHAT ARMING NEEDS.
 *
 * Two halves, each with the control that shows it can fail (a11ign/a11ign's `auto-arm-octo-sts.test.ts` is the original, #4198):
 *   - the POLICY (`.github/chainguard/auto-arm.sts.yaml`): grants pull-request write and contents write and nothing else, and its patterns accept the
 *     claims of main's copy of this workflow and refuse the ones that are not. Octo STS matches every pattern against the WHOLE claim (v0.11.2
 *     README), which `fullMatch` reproduces.
 *   - the WORKFLOW: the job mints before it uses, holds `id-token: write` and no other write, reads no stored token, falls back to nothing, and
 *     carries no `token-reach` probe of the token it no longer reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const withoutComments = (text: string) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

const fullMatch = (pattern: string, value: string) => new RegExp(`^(?:${pattern})$`).test(value);
/** The value of a top-level or nested `key: value` line of the policy; the policy is flat enough that a parser would add nothing. */
const field = (text: string, key: string) => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(withoutComments(text))?.[1];

const REPOSITORY_SUB = "repo:a11ign@320310787/screenreader-worker@1388747982";
const WORKFLOW = "a11ign/screenreader-worker/.github/workflows/auto-arm.yml";

const policyText = read(".github/chainguard/auto-arm.sts.yaml");
const POLICY = {
  subject_pattern: field(policyText, "subject_pattern")!,
  job_workflow_ref: field(policyText, "job_workflow_ref")!,
  event_name: field(policyText, "event_name")!,
};

/** Whether a policy would mint for a token with these claims. */
function mints(policy: typeof POLICY, claims: { sub: string; job_workflow_ref: string; event_name: string }): boolean {
  return fullMatch(policy.subject_pattern, claims.sub)
    && fullMatch(policy.job_workflow_ref, claims.job_workflow_ref)
    && fullMatch(policy.event_name, claims.event_name);
}

test("a11ign/a11ign#4199: the policy grants pull-request write and contents write, and nothing else", () => {
  const permissions = withoutComments(policyText).split("permissions:")[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(permissions, ["pull_requests: write", "contents: write"]);
});

test("a11ign/a11ign#4199: the policy mints for the runs of main's copy of this workflow and refuses the ones that are not its own", () => {
  const sub = (tail: string) => `${REPOSITORY_SUB}:${tail}`;
  const accepted = [
    ["push on main", { sub: sub("ref:refs/heads/main"), job_workflow_ref: `${WORKFLOW}@refs/heads/main`, event_name: "push" }],
    ["workflow_dispatch on main", { sub: sub("ref:refs/heads/main"), job_workflow_ref: `${WORKFLOW}@refs/heads/main`, event_name: "workflow_dispatch" }],
    // `pull_request_target` runs `main`'s copy and presents the same sub as `pull_request` (a11ign/a11ign#4191), so the workflow ref is what is pinned.
    ["pull_request_target (main's copy)", { sub: sub("pull_request"), job_workflow_ref: `${WORKFLOW}@refs/heads/main`, event_name: "pull_request_target" }],
  ] as const;
  for (const [label, claims] of accepted) assert.ok(mints(POLICY, claims), `${label} must mint`);

  const refused = [
    ["another workflow in this repository", { sub: sub("ref:refs/heads/main"), job_workflow_ref: "a11ign/screenreader-worker/.github/workflows/ci.yml@refs/heads/main", event_name: "push" }],
    ["a dispatch on another branch", { sub: sub("ref:refs/heads/agent/x"), job_workflow_ref: `${WORKFLOW}@refs/heads/agent/x`, event_name: "workflow_dispatch" }],
    // THE GAP a11ign/a11ign#4287's REVIEW CLOSED: a branch's own copy of the file must not mint, whatever its sub says.
    ["pull_request, the branch's copy of the file", { sub: sub("pull_request"), job_workflow_ref: `${WORKFLOW}@refs/pull/12/merge`, event_name: "pull_request" }],
    ["a pull_request event, even carrying main's workflow ref (the event is pinned too)", { sub: sub("pull_request"), job_workflow_ref: `${WORKFLOW}@refs/heads/main`, event_name: "pull_request" }],
    ["pull_request_target claims carrying a branch's workflow ref", { sub: sub("pull_request"), job_workflow_ref: `${WORKFLOW}@refs/pull/12/merge`, event_name: "pull_request_target" }],
    ["another repository's id", { sub: "repo:a11ign@320310787/other@1:ref:refs/heads/main", job_workflow_ref: `${WORKFLOW}@refs/heads/main`, event_name: "push" }],
    ["the name-form subject, which never matches (a11ign/a11ign#4191)", { sub: "repo:a11ign/screenreader-worker:ref:refs/heads/main", job_workflow_ref: `${WORKFLOW}@refs/heads/main`, event_name: "push" }],
    ["a workflow file merely ending the same way", { sub: sub("ref:refs/heads/main"), job_workflow_ref: `${WORKFLOW}.evil@refs/heads/main`, event_name: "push" }],
  ] as const;
  for (const [label, claims] of refused) assert.ok(!mints(POLICY, claims), `${label} must NOT mint`);
});

test("a11ign/a11ign#4199 POSITIVE CONTROL for the matcher: a policy widened to any subject mints for what the real one refuses", () => {
  const widened = { ...POLICY, subject_pattern: ".*" };
  const claims = { sub: "repo:evil@1/evil@2:pull_request", job_workflow_ref: `${WORKFLOW}@refs/heads/main`, event_name: "pull_request_target" };
  assert.ok(mints(widened, claims), "the matcher must be able to say yes");
  assert.ok(!mints(POLICY, claims), "and the real policy says no");
});

test("a11ign/a11ign#4199: arm mints for this identity, before the step that uses it, with pull_request_target, push and workflow_dispatch", () => {
  const text = read(".github/workflows/auto-arm.yml");
  const code = withoutComments(text);
  const mint = code.indexOf("uses: octo-sts/action@");
  const use = code.indexOf("steps.octo-sts.outputs.token");
  assert.ok(mint >= 0, "arm must mint with octo-sts/action");
  assert.ok(use > mint, "the step that reads the token must come AFTER the one that mints it");
  assert.match(code, /identity: auto-arm\n/, "arm must ask for the auto-arm identity");
  assert.match(code, /uses: octo-sts\/action@[0-9a-f]{40} # v/, "pin the commit, not the movable tag");
  assert.match(text, /^on:\n {2}pull_request_target:/m, "arm needs the trigger that runs main's copy");
  assert.doesNotMatch(text, /^ {2}pull_request:/m, "no pull_request trigger: it would run the branch's copy of this file");
  assert.match(text, /^ {2}push:/m, "the sweep after a merge needs the push trigger");
});

test("a11ign/a11ign#4199: the job holds the OIDC request and no write, and nothing reads a stored token or falls back to github.token", () => {
  const code = withoutComments(read(".github/workflows/auto-arm.yml"));
  assert.doesNotMatch(code, /^permissions:/m, "no workflow-level grant: the writes come from the minted token");
  assert.match(code, / {4}permissions:\n(?: {6}contents: read\n)? {6}id-token: write\n/, "the job holds id-token: write and at most a read");
  assert.doesNotMatch(code, /write-all|(?:pull-requests|contents|issues):\s*write/, "no write on GITHUB_TOKEN");
  assert.doesNotMatch(code, /secrets\.|github\.token|FALLBACK_TOKEN|A11IGN_BOT_TOKEN/, "no stored or fallback token");
  assert.doesNotMatch(code, /^ {2}token-reach:/m, "the probe of the stored token goes with the token");
});
