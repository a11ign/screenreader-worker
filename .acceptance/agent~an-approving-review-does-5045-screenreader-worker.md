Row a11ign/a11ign#5045, screenreader-worker's half of six (split from #5036 part 3). Region is `screenreader-worker:.github/workflows/auto-arm.yml`; the pin in `scripts/auto-arm-octo-sts.test.ts` is outside it and declared as such in the body. No `fleet:*`, `lab:*`, `worker:*` or capture command was run (resource ban), and no policy changed: `auto-arm.sts.yaml` already lists `workflow_dispatch` on `refs/heads/main`.

Acceptance:

```bash
cd /home/agent/repos/wt-5045-screenreader-worker && grep -q "^  pull_request_review:" .github/workflows/auto-arm.yml && node --test scripts/auto-arm-octo-sts.test.ts
```

**As run (measured, 2026-10-11):** `node --test scripts/auto-arm-octo-sts.test.ts` is `pass 6, fail 0` here; on `origin/main` with only the workflow ported it was `pass 4, fail 1` (the whole-file `github.token` pin), which is why the test is in this pull request. The `arm-approved` verdict program, extracted from this file and run through `jq` over 12 cases (approved draft readied; approved ready armed; already armed, held draft, held ready, fork, closed, merged, CHANGES_REQUESTED, empty decision and a base other than main left alone; a non-`hold:` label does not hold), answered each as expected. Every `run:` block passes `bash -n` and the file parses as YAML.

## What changed

- `.github/workflows/auto-arm.yml`: `pull_request_review: [submitted]` and a `workflow_dispatch` `pr` input; `relay` (`actions: write`, mints nothing, approved reviews of same-repository PRs against main) dispatches `main`'s copy; `arm-approved` (dispatch on `refs/heads/main`, mints through the existing `auto-arm` identity) re-reads the PR and runs `gh pr ready` + `gh pr merge --auto --merge` unless held, forked, closed, not against main, not APPROVED or already armed. `arm` skips `pull_request_review` and a dispatch carrying a `pr`; its concurrency group moved from the workflow onto the job, because a group keeps one pending run and a review landing during a sweep would otherwise replace the pending dispatch.
- `scripts/auto-arm-octo-sts.test.ts`: the `github.token` pin read the whole file; `relay` is cut out before the minting jobs are read (with a control that the cut is not vacuous) and pinned by its own test.

## Mutation (measured in control's worktree; this test block is byte-identical in all six repositories, md5 `2704ef7b…`; each mutant restored from a `cp` copy and `diff`ed byte-identical)

| Mutation | Tests that fail |
| --- | --- |
| `relay` gains `id-token: write` | exactly 1: relay's own |
| `relay` gains `pull-requests: write` | exactly 1: relay's own |
| `relay` fires on any review state | exactly 1: relay's own |
| `arm-approved` loses `github.ref == 'refs/heads/main'` | exactly 1: relay's own |
| the minting `arm` job reads `github.token` | 2: the minting-jobs pin and relay's own |
| `relay` loses its token | 2: the control that cuts it out, and relay's own |

## Not established

- **No live reading.** Whether an approving review readies and queues a draft in this repository is a reading of the MERGED file on a real pull request; the row names it as the gate's and `orchestrator`'s, not this pull request's.
- **`relay` answers 422 on this very pull request's review** (`main` declares no `pr` input until this merges); that case ends with a notice, not a failure, as in a11ign/a11ign.
- **A pull request opened before this merges keeps the old file** on its merge ref, so its first approval is not relayed; the next push or the sweep covers it.

Closes: none -- first half of a11ign/a11ign#5045
