THROWAWAY, NEVER MERGED (a11ign/a11ign#5061 Done-when 3): the diff against #47's branch is this file alone, none of `package.json`, `pnpm-lock.yaml`, `.npmrc` or `.github/workflows/`, so `release-dry-run` must read `success` without doing its work and `gate` must be green. Closed once its check run is read.

Acceptance: `grep -q "release-dry-run:" .github/workflows/ci.yml`
