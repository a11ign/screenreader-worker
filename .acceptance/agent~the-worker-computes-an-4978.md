The worker can compute an RFC 6238 authenticator code and refuses a missing or malformed seed by the variable's name: `src/totp.ts` (pure, `node:crypto` only) and `src/totp.test.ts`. Nothing imports it: no change to `auth-flow.ts`, `capture-auth.ts` or the wire (the wiring row is held for the chairman's design direction). Part of a11ign#4084.

Acceptance:

```bash
git grep -q "POSITIVE CONTROL" -- src/totp.test.ts
git grep -q "NEGATIVE CONTROL" -- src/totp.test.ts
npx rstest run src/totp.test.ts
```

Evidence (measured in this worktree): the command exits 0, `9 tests` pass in `src/totp.test.ts` (it did not exist on `main`); `pnpm run lint` and `pnpm run typecheck` clean; `pnpm run build && pnpm test` 754 passed, 19 skipped (without the build, `scripts/built-package.test.ts` fails 6, as on `main`).

Mutation: skipping the wait (no sleep, no floor at the window edge) turned 2 tests red (`NEGATIVE CONTROL: under three seconds left...` and `...the edge is exactly three seconds`); putting the seed into the non-base32 refusal turned 1 red (`no refusal message carries the seed value`). Each restored byte-identical (diffed).

no-release: `src/totp.ts` is imported by no entry and is not in `WORKER_FILES`, so nothing shipped changes and `/health.code` does not move (`code-version.test.ts` passes).

Closes a11ign/a11ign#4978
