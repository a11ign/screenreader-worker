Row a11ign/a11ign#5648: the worker's `left-origin` sentence stops calling an identity-provider redirect SSO "which v1 does not do". The new sentence is the row's, character for character, in `src/auth-flow.ts` and in the parity literal `leftOriginSentence` in `src/auth-flow-idp.test.ts`. a11ign#5644 waits on this and does the CLI's bump, not this PR.

Acceptance:

```bash
git grep -q "which v1 does not do" -- src; test $? -eq 1
pnpm exec rstest run --config rstest.config.ts src/auth-flow-idp.test.ts
```

**As run (measured, 2026-10-16):** both commands in this branch's worktree. The first exits 1 (no match). The second is `VERDICT pass: 29 tests in 1 file (1 skipped)`. The first command as the row writes it, in `~/repos/screenreader-worker`, reads the primary checkout, which is on `main` at `5cfcc5a`, behind `origin/main`, and still carries the old sentence in `src/auth-flow.mjs`; that is a stale checkout, not this change. Mutation: with `origin/main`'s `src/auth-flow.ts` put back in place, the new test fails on the old sentence (`F01` and `F02` among them); the change restored byte-identical.

Full suite: `pnpm run build` then `pnpm test` is `VERDICT pass: 858 tests in 98 files (19 skipped)`; `pnpm run lint` exits 0; `pnpm run typecheck` exits 0.

## What changed

- `src/auth-flow.ts`: `assertStillOnOrigin` sends the new sentence with `left-origin`.
- `src/auth-flow-idp.test.ts`: `leftOriginSentence` carries the same sentence.
- `.changeset/left-origin-names-the-declared-origin.md`: a `patch` for `@a11ign/screenreader-worker`, since the sentence is user-facing and changes wording only.

Not changed, and not in the Region: `docs/try-it.md` still describes SSO support in its own words.
