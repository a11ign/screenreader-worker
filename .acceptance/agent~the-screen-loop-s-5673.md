The screen loop's branches carry the alerts and controls the screen showed (a11ign/a11ign#5673, the worker's side of #5564). A wrong one-time code on real Auth0 ended `signed-in-check-never-matched`, and the record could not say whether the alert text missed the `totp-rejected` regex or the alert was never read. `Branch` now carries `alerts` (each `alert` control as role and name, `[]` when there is none) and `controls` (every control, as role and name), and a `stop` branch carries both.

Acceptance:

```bash
pnpm exec rstest run src/screen-loop.test.ts
```

**As run (measured, 2026-10-16):** the row's `cd ~/repos/screenreader-worker && ...` form runs in the primary checkout, which is 79 commits behind `origin/main` and does not carry this change. It is run here in this branch's worktree, as the form above, which is `VERDICT pass: 44 tests in 1 file`.

## What changed

- `src/screen-loop.ts`: `BranchControl` (role and name only), and `Branch.alerts` and `Branch.controls`. `actOn` records both on every branch, including `stop`.
- `src/screen-loop.test.ts`: a `describe` block for #5673 with positive controls (a stop branch carries the alert; it carries every control), a negative control (a `className` never reaches `controls`; a typed value never reaches `result.branches`), and the `alerts: []` case for a screen with no alert.
- `.changeset/the-screen-loop-records-its-alerts-5673.md`: patch.

## Evidence

- Targeted: `VERDICT pass: 44 tests in 1 file`.
- Before the implementation change, with the new tests in place, 4 of 44 failed.
- `pnpm run typecheck` and `pnpm run lint` exit 0.
- `pnpm run build`, then `pnpm test`: `VERDICT pass: 865 tests in 98 files (19 skipped)`. Without the build, `scripts/built-package.test.ts` fails six tests on a missing `dist/`, which CI avoids by running the build first.

## Mutation (measured in this worktree; each restored and diffed byte-identical)

| Mutation | Result |
| --- | --- |
| Stop branch drops its record (`outcome` only, no `alerts` or `controls`) | `fail: 2 of 44`: the two stop-branch tests. |
| `alerts` always `[]` | `fail: 1 of 44`: the positive control. |
| `controls` copies every property (`{ ...c }`, so `className` leaks) | `fail: 2 of 44`: the stop-branch controls test and the `className` negative control. |
| Unmutated | `pass: 44 of 44` |

The no-value test (a typed secret never reaches `result.branches`) passes on `main` by design: the loop never receives a typed value, so this pins a contract that a later change could break.

## Not verified here

- The primary checkout's copy of the row's command was not run; see "As run" above.
- The `worker:state` and merge steps belong to the gate and the release process.
