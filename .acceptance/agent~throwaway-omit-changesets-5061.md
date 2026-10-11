THROWAWAY, NEVER MERGED (a11ign/a11ign#5061 Done-when 2): `pnpm-lock.yaml` omits `@changesets/cli`, so the `release-dry-run` job of #47 must be RED on this pull request. The pull request is closed once that check run is read.

Acceptance: `! grep -qF "'@changesets/cli':" pnpm-lock.yaml`
