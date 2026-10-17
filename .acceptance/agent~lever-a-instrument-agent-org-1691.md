Row a11ign/agent-org#1691 (Lever A instrument, split from #1685): the `sweep` mark's trip split adds up to the direction's span. `onItem` now runs inside its own `itemMs` bucket (`tripItemMs` under `prevSplit` and `nextSplit`, in `src/capture-probes.ts`), and the trip buckets are measured with `performance.now()` so a sub-millisecond round is not read as zero. `src/sweep-step.test.ts` pins that an `onItem` taking 50 ms lands in `itemMs` with the buckets summing to the span within 5 ms, and that 200 immediate rounds add up to more than zero.

Acceptance: `git grep -q "itemMs" -- src/capture-probes.ts && git grep -q "performance.now" -- src/capture-probes.ts`

Mutation: removing the `spendTrip(trips, "itemMs", ...)` bracket around `onItem` fails "onItem's own time lands in itemMs" and "a sweep step's onItem runs through the real call site"; reverting the `spendTrip` clock to `Date.now()` fails only "a round that takes under a millisecond still adds to its bucket". Dropping `trips` from `sweepInDirection`'s call to `collectPhrase` fails "a sweep step's onItem runs through the real call site" (`Cannot read properties of undefined (reading 'itemMs')`). Each was run and the file restored byte-identical.

Fail-before: against `origin/main`'s `src/capture-probes.ts` the updated `src/sweep-step.test.ts` fails 6 of 17 tests.

Suite: `pnpm run typecheck`, `pnpm run lint`, `pnpm run build` and `pnpm test` exit 0 (873 passed, 19 skipped).
