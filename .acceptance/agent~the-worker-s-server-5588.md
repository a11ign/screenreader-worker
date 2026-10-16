Row a11ign/a11ign#5588, the worker's entry check: the server exits 0 with no output when started through a symlinked or junctioned path, because `IS_MAIN` compared a real path with `argv[1]` as given. The pure check lives in `src/is-entry-point.ts`, a sibling module the server imports, so the test can answer without importing the server, which starts its samplers on load.

Acceptance:

```bash
pnpm exec rstest run --config rstest.config.ts src/server-entry.test.ts
```

**As run (measured, 2026-10-16):** the row's command, `cd ~/repos/screenreader-worker && ...`, runs in the primary checkout, which is on `main` and does not carry this test. It is run here in this branch's worktree, as the form above, which is `VERDICT pass: 6 tests in 1 file`.

## What changed

- `src/is-entry-point.ts` (new): `isEntryPoint(metaUrl, argv1)` resolves `argv1` and the module's own file with `realpathSync` and compares the two URLs. An empty or missing `argv1`, or a path that does not resolve, is false, not a throw.
- `src/server.ts`: `IS_MAIN` is `isEntryPoint(import.meta.url, process.argv[1])`. Every `if (IS_MAIN)` site is unchanged.
- `src/worker-files.ts`: `is-entry-point.ts` added to `WORKER_FILES`, because `server.ts` imports it and `code-version.test.ts` refuses a split that is not listed. `/health.code` moves with this change, as it does for any `server.ts` change.
- `src/server-entry.test.ts` (new): controls (a) to (e) from the row, plus (a2), a directory link, which is the junction shape.
- `.changeset/the-worker-s-server-5588.md`: patch.

## Evidence

- `pnpm run lint` exits 0; `pnpm run typecheck` exits 0.
- `pnpm run build`, then `pnpm test` as CI runs it: `VERDICT pass: 858 tests in 98 files (19 skipped)`. Without the build, `scripts/built-package.test.ts` fails six tests on a missing `dist/`, which is the failure CI avoids by running the build first.
- Built server through a symlinked `dist` directory, `A11Y_PORT` set to a spare port, under a 6 s `timeout`: `listening on :18588`, exit 124 (still running, killed by the timeout). The same build through its real path: the same listen line.
- The same built bundle with the `main` comparison put back in its `IS_MAIN` line, run through the same symlink: exit 0, no output. That is the reported failure.

## Mutation (measured in this worktree; each restored and diffed byte-identical)

| Mutation | Result |
| --- | --- |
| Naive comparison (`metaUrl === pathToFileURL(argv1 ?? "").href`, the `main` form) | `fail: 2 of 6`: (a) and (a2), the two link controls. (b), (c), (d) and (e) pass. |
| Always true (`return true`) | `fail: 3 of 6`: (c), (d) and (e). (a), (a2) and (b) pass. |
| Unmutated | `pass: 6 of 6` |

## Not verified here

- **The row's step 1 (read on worker-5) was not run.** It is a read on a fleet box, which the engineer brief keeps with `orchestrator`, and the row says `orchestrator` is cleared to do it on a11ign#5155. The PR body says so and does not claim the read.
- **Windows was not run.** The junction case is covered by (a2) with a directory symlink on Linux. The live start under the `node_modules` launcher is the VERIFY step after a release.
