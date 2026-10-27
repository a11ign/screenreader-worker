Refs A11-254

Step 2 of 2 (screenreader-worker): adopts the generated `.github/workflows/dependabot-auto.yml` from `@a11ign/toolchain` 0.13.0. A Dependabot pull request whose update is a patch, a minor or a non-major GitHub Actions update, with every commit Dependabot's, is approved as the Octo STS App and handed to `auto-arm.yml`'s `arm-approved`, so it merges through `merge-queue-main` when `gate` is green. A major is never approved. A red `ci` run on a Dependabot pull request is rerun once if it reads as infrastructure, and otherwise commented with the failing job's error lines. Two hand-written Octo STS policies bind the approval to this repository's `main` copy of the workflow and to `dependabot[bot]` (actor id 49699333); `dependabot-config --check` verifies both, and fails when any other workflow submits an approval.

Acceptance:

```bash
set -e
pnpm install --frozen-lockfile
pnpm exec dependabot-config --check
node --test scripts/dependabot-config.test.ts
test -f .github/workflows/dependabot-auto.yml
grep -qF 'subject: repo:a11ign@320310787/screenreader-worker@1388747982:pull_request' .github/chainguard/dependabot-approve.sts.yaml
grep -qF 'actor_id: "49699333"' .github/chainguard/dependabot-approve.sts.yaml
grep -qF 'subject_pattern: repo:a11ign@320310787/screenreader-worker@1388747982:(pull_request|ref:refs/heads/main)' .github/chainguard/dependabot-guard.sts.yaml
grep -qF 'job_workflow_ref: a11ign/screenreader-worker/\.github/workflows/dependabot-auto\.yml@refs/heads/main' .github/chainguard/dependabot-approve.sts.yaml
# the approval identity grants pull-request write and nothing else
[ "$(sed -n '/^permissions:/,$p' .github/chainguard/dependabot-approve.sts.yaml | tail -n +2 | grep -c .)" = 1 ]
```
