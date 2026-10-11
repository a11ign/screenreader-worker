A pull request touching `package.json`, `pnpm-lock.yaml`, `.npmrc` or `.github/workflows/` runs a `release-dry-run` job in `ci.yml` (a11ign/agent-org#885 class 3, a11ign/agent-org#888): the release's version step on a scratch clone, as `release.yml`'s call of `release-per-merge.yml` runs it. `gate` needs the job and reads its result.

Acceptance: `grep -q "release-dry-run:" .github/workflows/ci.yml && grep -q "needs.release-dry-run.result" .github/workflows/ci.yml`

The row's own command names `/home/agent/repos/screenreader-worker/.github/workflows/ci.yml`, the primary checkout on the host, which has this change only after the merge is pulled; the command above is the same two greps at this pull request's head.

Region: `.github/workflows/ci.yml`
