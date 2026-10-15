Row a11ign/a11ign#5535, the worker's copy of the screen loop's landing guard (sibling of a11ign#5534). The app's callback page returns as `landing` after the provider's forms, while its token exchange is still in flight, and the loop pressed `Sign in` again: the second login raced the first. Region is `src/screen-loop.ts`, `src/screen-loop.test.ts` and `.changeset/`.

Acceptance:

```bash
grep -q "a11ign#5534" src/screen-loop.test.ts && pnpm exec rstest run src/screen-loop.test.ts
```

The command runs from the root of this pull request's checkout. The primary checkout at `/home/agent/repos/screenreader-worker` is on `main` at `5cfcc5a` and has no `src/screen-loop.ts`, so a `cd` into it cannot pass; the reading below is this head.

**As run (measured, 2026-10-15):** `pnpm exec rstest run src/screen-loop.test.ts` is `passed 39, failed 0` at this head; on `origin/main` with only the two new tests added it is `failed 2` (both report `Expected 1, Received 2` presses). `pnpm run typecheck` and `pnpm exec eslint` on the two changed sources are clean. `pnpm test` is `852 tests in 97 files (19 skipped)`, after `pnpm run build` (the built-package tests read `dist/`).

## What changed

- `src/screen-loop.ts`: the loop records whether the landing has been pressed (`landingAlreadyPressed`); a landing that comes back after that is waited on, never pressed. The first press is unchanged.
- `src/screen-loop.test.ts`: `[LANDING, COMBINED, OTP, LANDING, LANDING, SIGNED_IN]` presses `Sign in` once and signs in; `[LANDING, COMBINED, OTP, LANDING]` presses once and ends `signed-in-check-never-matched`.

## Mutation (measured in this worktree; each mutant restored from a `cp` copy and `diff`ed byte-identical)

| Mutation | Tests that fail |
| --- | --- |
| the landing guard never fires (`if (false)`) | exactly 2: the two a11ign#5534 cases |
| the landing guard always fires (every landing waits) | 4: the two a11ign#5534 cases and the two existing landing cases that need the first press |
