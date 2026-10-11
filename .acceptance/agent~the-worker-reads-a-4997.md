The worker reads a TOTP secret given as a bare base32 seed or an `otpauth://totp/` URI into `{ seed, algorithm, digits, periodSeconds }`, defaulting SHA1/6/30; refusals are by name and never echo the value: `src/otpauth.ts` (pure, calls `requireTotpSeed`) and `src/otpauth.test.ts`. Nothing imports it: no change to `auth-flow.ts`, `capture-auth.ts` or the wire. Part of a11ign#4084.

Acceptance:

```bash
git grep -q "POSITIVE CONTROL" -- src/otpauth.test.ts
git grep -q "NEGATIVE CONTROL" -- src/otpauth.test.ts
npx rstest run src/otpauth.test.ts
```

Evidence (measured in this worktree): the command exits 0, `16 tests` pass in `src/otpauth.test.ts` (it did not exist on `main`); `pnpm run lint` and `pnpm run typecheck` clean.

Mutation: ignoring `period` (always the 30 s default) turned 6 of 16 tests red; putting the URI into the missing-secret refusal turned 1 of 16 red (the no-leak test). Each restored byte-identical (diffed).

no-release: `src/otpauth.ts` is imported by no entry and is not in `WORKER_FILES`, so nothing shipped changes and `/health.code` does not move.

Closes a11ign/a11ign#4997
