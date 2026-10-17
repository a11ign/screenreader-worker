Row a11ign/agent-org#1685 (Lever A, second cut, split from #1679): the `sweep` mark carries, per direction, the milliseconds its round trips spent in `perform`, in `spokenPhraseLog` and in quiet waits (`prevSplit` and `nextSplit` in `src/capture-probes.ts`). `src/sweep-step.test.ts` pins that both directions carry all three. This pull request makes no cut: the split has not been read on a runner, and the recapture row it files decides whether one can be made.

Acceptance: `git grep -q "tripPerformMs" -- src/capture-probes.ts && git grep -q "tripLogMs" -- src/capture-probes.ts && git grep -q "tripQuietMs" -- src/sweep-step.test.ts`

Fail-before: the new test in `src/sweep-step.test.ts` fails against `origin/main`'s `src/capture-probes.ts` with `0 !== 2` and passes against this branch's file.

Suite: `pnpm run typecheck`, `pnpm run lint`, `pnpm run build` and `pnpm test` exit 0 (866 passed, 19 skipped).

Stale checkout: the row's command as the row writes it, run in `~/repos/screenreader-worker`, reads the primary checkout, which is on `main` at `5cfcc5a`, behind `origin/main` at `6b1c1b6`, and exits 1 there. The Acceptance above is the same grep run from this branch's worktree, where it exits 0.
