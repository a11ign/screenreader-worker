The worker holds its own copy of the login screen loop and runs it for a request carrying `auth.loginBlock` (v3 login phase 2, the worker's copy of a11ign#4084): `src/screen-loop.ts` is a pure copy of the CLI's `packages/cli/src/auth/screen-loop.ts` with the `login-outcomes` names inlined as literals; `src/auth-flow.ts` runs it over CDP; `src/screen-loop.test.ts` repeats every case the CLI's loop test pins as a literal (nothing imported across the two); `src/auth-flow-idp.test.ts` pins the wiring against a scripted fake site. The wire's new field is `auth.loginBlock = { url, usernameEnv, passwordEnv, totpEnv, check, organization? }`, validated again on arrival and carrying env-var NAMES only.

Acceptance:

```bash
git grep -q "POSITIVE CONTROL" -- src/screen-loop.test.ts
git grep -q "NEGATIVE CONTROL" -- src/screen-loop.test.ts
npx rstest run src/screen-loop.test.ts src/auth-flow-idp.test.ts
```

Evidence (measured in this worktree): the command exits 0 with `57 tests` passing in the two files (1 skipped: the real-Chromium CDP test, which cannot start on this host, Chromium exits 127); `src/screen-loop.test.ts` did not exist on `main`. `pnpm run lint` and `pnpm run typecheck` clean; the full suite passes after `pnpm run build`.

Mutation: classifying by CSS class turned 2 named `screen-loop` tests red; accepting any string as an env name turned the NAME-vs-value test red; dropping the signed-out-check refusal turned its test red; dropping the post-login wall assertion turned the session-lost test red; dropping the origin assertion before observing, and the one before each fill, each turned a named test red. Each restored byte-identical (diffed).

Not verified here: the CDP `autocompleteOf` and `pressEnter` against a real Chromium (the test is skipped on this host), and the TOTP `usedWindow` guard has no test of its own.

Outside-Region: `src/worker-files.ts` names the three new files because `code-version.test.ts` walks the imports of the shipped files and refuses one that is not in `WORKER_FILES`. `/health.code` moves on merge for every worker.

Closes a11ign/a11ign#4998
