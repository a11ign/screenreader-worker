The worker's flow interpreter learns the four keys the CLI already runs (#4994, PR #5035): `when:`, `optional:`, `dismiss-if-shown:` and `auto:`. Until now a flows file using them reached a worker that refused it as "not a step".

**Semantics (same as the CLI, `packages/cli/src/auth/flows.ts` and `interpreter.ts`):**
- `when:` runs its step only if the condition is on the page. It reads once and never waits. Refused on `capture` and `dismiss-if-shown`.
- `optional:` waits as long as a bind would, and skips only when no control of that name ever appeared. Refused on `goto`, `capture` and `dismiss-if-shown`. On `expect:` it has no effect, so an expect that never comes true still fails.
- `dismiss-if-shown:` presses its control if it is on the page, and skips without failing if not.
- `auto:` is refused by name. The worker runs its screen loop only for `auth.loginBlock`, so a flow cannot ask for it.
- The login's last `expect:` may not carry `when:`, because the login's last step always runs.
- Each new key refuses a selector or a script, as the rest of the vocabulary does.

**Controls.** Positive and negative controls are named in the test comments in `src/auth-flow.test.ts`. Against `origin/main`, six of the new tests fail; on this branch all 43 pass. Mutation checks in both directions (eight mutations: each one fails the suite, and the file is restored byte-for-byte).

**Not verified here.** The lab-side parity test cited in the worker header (`packages/lab/src/packaging/auth-flow-parity.test.ts`) is not in this checkout, so FLOW_VERBS parity with the CLI is not pinned by a test in this PR. The primary checkout at `/home/agent/repos/screenreader-worker` is stale (still has `auth-flow.mjs`), so the row's Acceptance `git grep` will pass there only after this PR merges and the checkout is pulled.

Acceptance: `git grep -q "dismiss-if-shown" -- src/auth-flow.ts` and `pnpm exec rstest run src/auth-flow.test.ts`
Closes #5037

🤖 Generated with [Claude Code](https://claude.com/claude-code)
