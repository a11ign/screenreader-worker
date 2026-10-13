The worker's screen loop learns the `landing` screen that a11ign/a11ign#5289 taught the CLI's loop (#5278). The worker runs its own copy of `screen-loop.ts` (a65789c1), and the capture's login runs in the worker. So `a11ign@0.10.3` carried the fix while `@a11ign/screenreader-worker@0.13.0` did not, and the Auth0 end-to-end run still ended `unknown-screen` on the test app's "Sign in required" page: auth-capture-check run 38481223389, recorded on a11ign/a11ign#5293.

The change is #5289's, applied to the worker's copy hunk for hunk:
- `"landing"` is added to `FORM_SCREENS`, with `LANDING_NAME`, its matcher and its decision.
- #5289's three tests are repeated here as literals, as this file's header says the CLI's cases are, in one `describe` of their own: the positive control, two sign-in controls not pressed, and an unchanged landing pressed once. Lint (`max-lines-per-function`) is clean.

Acceptance:
```bash
node --test src/screen-loop.test.ts
```

Result: 31/31 pass. Mutation: with `src/screen-loop.ts` restored to `main`, 2 of 31 fail (the positive control and the pressed-once test), so the tests reach the change.

Closes: none. The row is a11ign/a11ign#5278, closed by #5289, whose Done-when 2 and 3 (the dispatch runs) wait on this release.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
