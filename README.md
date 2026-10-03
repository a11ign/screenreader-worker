# screenreader-worker

The worker that drives a real NVDA screen reader on Windows through real navigation and returns what it announced, and
the NVDA-announcement port that runs without Windows. Moved here from [`a11ign/a11ign`](https://github.com/a11ign/a11ign)
with its history (`packages/nvda-worker`, `packages/nvda-speech`).

| | |
|---|---|
| [`packages/nvda-worker`](packages/nvda-worker) | `@a11ign/screenreader-worker`, **AGPL-3.0-or-later**. The HTTP contract is the API. See its README. |
| [`packages/nvda-speech`](packages/nvda-speech) | `@a11ign/nvda-speech`, **GPL-3.0-or-later** (derived from NVDA), **private**: never published on its own. |

The root [`LICENSE`](LICENSE) is the worker's, byte for byte.

**The worker has no authentication.** Anyone who can reach its port can drive the browser and the screen reader on that machine
(`SECURITY.md` in `a11ign/a11ign` says what else somebody must know first). Run it only on a machine and a network you control.

## Working here

```bash
pnpm install --frozen-lockfile
pnpm test        # what the `gate` check runs on every pull request and merge-queue entry
```

`main` takes pull requests only, each with one approving review, through the merge queue.

## Releasing

This repository releases on its own, not with `a11ign/a11ign`. A change that should reach npm carries a changeset
(`pnpm exec changeset`); its merge opens the **Version packages** pull request, and **merging that is the release**
(`.github/workflows/release.yml`, `.changeset/README.md`). The publish uses npm trusted publishing over OIDC with
provenance and no stored token.
