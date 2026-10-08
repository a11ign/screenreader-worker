# Changesets

A change that should reach npm carries a changeset: `pnpm exec changeset`, naming `@a11ign/screenreader-worker` and the size of the change.

**Merging one to `main` is the release.** `release.yml` calls the one reusable per-merge workflow (`release-per-merge.yml` in `a11ign/toolchain`): a push whose tree carries a changeset no tag has consumed is versioned on a detached commit, published, tagged and released. There is no version pull request, and nothing is written to `main`, so its package versions and changelogs lag the last tag.
