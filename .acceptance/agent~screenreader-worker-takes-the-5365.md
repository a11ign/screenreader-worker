Row a11ign/a11ign#5365, amended 2026-10-13 by product-manager (option a): the screenreader-worker half of the port out of control (from a11ign/a11ign#5345). Three tests read the worker's own source alone and move here: the lazy-import pair from `no-win32-imports.test.ts` and the worker-only displayAdapter comment guard from `fleet-consistency.test.ts`. The three list-dependent guards (`EVERY MUST_MATCH FIELD ...`, `#2063: EVERY REPORTED_ONLY FIELD ...`, `#2211: every hardware reading ...`) read control's field lists and stay in control, where `worker-fleet-carried.ts` lives.

Acceptance:

```bash
bash -c 'cd ~/repos/screenreader-worker && git fetch -q origin && git grep -q "guidepup is a lazy import now" origin/main -- src && git grep -q "the worker.s own displayAdapter comment claims no absence either" origin/main -- src'
```

**As run (2026-10-13, in this branch's worktree):** the two titles are present in `src/` of this branch (`git grep` over the working tree reads them once tracked); the command against `origin/main` can only pass once this PR merges, so it is expected to exit `1` before the merge. The third ported title, `the poison really is reachable from a real file, or this guard proves nothing`, is in `src/no-win32-imports.test.ts` and is not named by the row's Acceptance command.

## What changed

- `src/no-win32-imports.test.ts` (new): the two lazy-import tests from control's `no-win32-imports.test.ts`, titles kept. The walker reads the worker's `src/index.ts` as text from disk and follows static `import`/`export ... from` edges. Control's version walked `packages/nvda-worker/src/index.ts`, a path that does not exist in control, so that test was vacuous there. The positive control is an in-memory module map: a planted chain `entry.ts -> middle.ts -> @guidepup/guidepup` must be found, and a dynamic `await import()` of the driver must not be flagged. No file in the worker statically reaches `@guidepup/guidepup` (`capture-setup.ts` and `capture-probes.ts` use `await import()` inside `ensureGuidepup`), so a planted fixture is the only chain the walker can be shown.
- `src/worker-text-fleet-consistency.test.ts` (new): `#2211: the worker's own displayAdapter comment claims no absence either`, with its helpers, title kept. It reads `src/server.ts` beside the test file, not through the layer checkout.

## Mutation (measured in this worktree; each restored and re-run)

| Mutation | Result |
| --- | --- |
| `import "@guidepup/guidepup";` appended to `src/capture-core.ts` | `fail: 1 of 2` in `no-win32-imports.test.ts`; the message names the chain `index.ts -> capture-core.ts -> @guidepup/guidepup` |
| `"until this code is deployed"` added to the `REPORTED, NEVER GATED` comment in `src/server.ts` | `fail: 1 of 1` in `worker-text-fleet-consistency.test.ts` |
| unmutated | `pass: 3 of 3` |

## Checks

- `pnpm run lint` exits 0; `pnpm run typecheck` exits 0.
- `pnpm test` in a fresh worktree without `dist/` fails 6 tests in `scripts/built-package.test.ts` (they read the built package). After `pnpm run build`, `pnpm test` is `VERDICT pass: 841 tests in 97 files (19 skipped)`.

## Not established

- **The "real file" title overstates the control.** The first test's positive control is a planted fixture, kept under the title the row specifies. The fixture stands in for a real file because no worker file reaches the driver statically.
- **`pnpm run verify` is not defined in this repository's `package.json`.** The PR-ready check was run as `pnpm run lint`, `pnpm run typecheck` and `pnpm test` above.
