# Changesets

A change that should reach npm carries a changeset: `pnpm exec changeset`, naming `@a11ign/screenreader-worker` and the size of the change.

Merging one to `main` makes `release.yml` open (or update) the ONE **Version packages** pull request. **Merging that pull request is the release:** the push it makes carries no pending changeset and a version ahead of the registry, so `release.yml` publishes. Nothing is typed and nothing pushes to `main`. `scripts/release-plan.mjs` is where that decision is made, and `scripts/release-plan.test.ts` pins it.

`@a11ign/nvda-speech` is `private` and never versions or publishes (`privatePackages` in `config.json`).
