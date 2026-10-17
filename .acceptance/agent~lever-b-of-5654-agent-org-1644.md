Row a11ign/agent-org#1644 (Lever B of #5654, the cut only): `MAX_SWEEP_STEPS`, the per-direction cap on a quick-nav sweep, is lowered from 250 to 150 in `src/capture-probes.ts`, and is exported so `src/sweep-step.test.ts` can pin the behaviour. The test drives `sweepInDirection` with a fake NVDA that announces a new phrase on every step and asserts the sweep stops at exactly `MAX_SWEEP_STEPS` with `stop: "cap"`. This pull request makes no claim about capture time. Whether the lower cap costs evidence is the recapture's reading in a11ign/agent-org#1695, not this pull request's.

Acceptance: `git grep -q "^export const MAX_SWEEP_STEPS = 150;" -- src/capture-probes.ts && ! git grep -q "const MAX_SWEEP_STEPS = 250;" -- src/capture-probes.ts`

Fail-before: the new test in `src/sweep-step.test.ts` fails against `origin/main`'s `src/capture-probes.ts` (1 of 18 tests failed, the new one, because that file does not export `MAX_SWEEP_STEPS`) and passes against this branch. It also fails when the loop bound is broken in either direction (`i < Infinity`, `i < 1`), checked by a script that restored the file byte-identical afterwards.

Suite: `pnpm run typecheck` and `pnpm run lint` exit 0; `pnpm run build` exits 0; `pnpm test` exits 0 (874 passed, 19 skipped, after the build so the built-package tests have a `dist` to read).
