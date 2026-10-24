Refs A11-203

Step 7 of 8 (screenreader-worker): `auto-arm.sts.yaml` now asks Octo STS for `workflows: write` as well, so GitHub no longer refuses `enablePullRequestAutoMerge` to the arm bot for an approved pull request that changes a file under `.github/workflows/`. The `WHAT IT HOLDS` comment names the third grant and a new `WHY workflows` paragraph says why (a11ign/lab#150, lab#148, the chairman's decision of 2026-10-24). The pinning test asserts the three grants. The issuer, `subject_pattern` and `claim_pattern` (`job_workflow_ref`, `event_name: pull_request_target|push|workflow_dispatch`) are unchanged, so only main's own `auto-arm.yml` can get the token.

The diff touches only the policy and its pinning test, the policy's non-comment diff is the one added line, the comment gives the reason, and the pinning test passes.

Acceptance:

```bash
# only this step's paths (plus .acceptance/): awk exits 1 on any other path
git diff --name-only origin/main...HEAD | awk '$0 !~ /^(\.acceptance\/|\.github\/chainguard\/auto-arm\.sts\.yaml$|scripts\/auto-arm-octo-sts\.test\.ts$)/ { bad = 1 } END { exit bad }'
# the non-comment policy diff is exactly the one added line: awk exits 1 on any other changed non-comment line, so the binding and subject pattern did not change
git diff -U0 origin/main...HEAD -- .github/chainguard/auto-arm.sts.yaml | awk '/^[-+][^-+#]/ && $0 != "+  workflows: write" { bad = 1 } END { exit bad }'
git diff -U0 origin/main...HEAD -- .github/chainguard/auto-arm.sts.yaml | grep -qxF '+  workflows: write'
# the comment says why
grep -q 'A11-203' .github/chainguard/auto-arm.sts.yaml
grep -q '2026-10-24' .github/chainguard/auto-arm.sts.yaml
# the pinning test (node strips the types)
node --test scripts/auto-arm-octo-sts.test.ts
```
