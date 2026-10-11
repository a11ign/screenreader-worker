Row a11ign/a11ign#5083, screenreader-worker's half of ADR 0045 cut 5 of 9: the package publishes a launcher built for the `node_modules` layout, and the foreground-lock script it runs beside itself. `src/run-server.cmd` is unchanged (the core's provision stamp hashes it; row 6 owns its removal). No live Windows run was made here, which the row keeps for orchestrator's VERIFY row (Fleet: Yes).

Acceptance:

```bash
bash -c 'cd /home/agent/repos/screenreader-worker && pnpm exec rstest run src/launcher-published.test.ts'
```

**As run (measured, 2026-10-11):** the command as written, in `/home/agent/repos/screenreader-worker`, is REFUSED (`VERDICT REFUSED: 0 tests run`), because that checkout is on `main` and the test exists only on this branch. The same command in this branch's worktree is `VERDICT pass: 5 tests in 1 file`. The full suite (`pnpm test`, after `pnpm run build`, as CI does) is `VERDICT pass: 838 tests in 95 files (19 skipped)`; `pnpm run lint` exits 0; `pnpm run typecheck` exits 0.

## What changed

- `launcher/run-server.cmd` (new, published): resolves `dist\server.mjs` and `apply-foreground-lock-timeout.ps1` from its own location (`%~dp0`) to absolute paths before any `cd`. Starts `dist\server.mjs`, not `server.ts`. Keeps the `server.log` lines and the node discovery order (argument 1, then the four absolute candidates, then PATH with a warning). The working directory is argument 2, or `A11Y_WORKER_DIR`; with neither it prints FATAL and exits 1 rather than guessing. The lock script's absence is a WARNING line in `server.log` and on the console, not a silent skip.
- `launcher/apply-foreground-lock-timeout.ps1` (new, published): byte-identical to the fleet's copy (`packages/worker-fleet/src/provisioning/apply-foreground-lock-timeout.ps1`, sha256 `1907969a…dd0dc0d`). The copy was taken from a local checkout of the fleet repo, not from this package's code; the launcher and the test do not read the fleet's file.
- `package.json`: `"launcher"` added to `files`.
- `src/launcher-published.test.ts` (new): packs with `npm pack --dry-run --json --ignore-scripts` and asserts both launcher files are listed; asserts the launcher text names `dist\server.mjs` and neither `packages\` nor `server.ts`. Positive and negative controls, plus an in-test mutant (`dist\server.mjs` → `server.ts`) that the check must flag.
- `.changeset/launcher-ships-in-the-package.md`: minor.

## Mutation (measured in this worktree; each restored and re-run)

| Mutation | Result |
| --- | --- |
| `launcher` removed from `files` | `fail: 1 of 5` (the pack-listing test) |
| `run-server.cmd` server line changed to `"%~dp0server.ts"` | `fail: 2 of 5` (the `dist\server.mjs` test and the mutation test) |
| unmutated | `pass: 5 of 5` |

## Stamp consequence

**None in this PR.** `provisionRevision` hashes `src/run-server.cmd` and the fleet's `apply-foreground-lock-timeout.ps1` at their existing paths, and this PR changes neither. The row's wording says the stamp changes; that happens when row 6 repoints the stamp at `launcher/` and removes `src/run-server.cmd`, and row 6 owns that change. `codeVersion()` hashes an explicit `WORKER_FILES` list, which these new files are not in.

## Not established

- **The `.cmd` has not been executed.** No Windows host or `cmd` is available here, so the batch logic is verified by reading and by the text checks above, not by running it. The live run is the VERIFY row's.
- **Nothing runs the published launcher yet.** The scheduled task passes argument 1 only; until row 6 adds argument 2 (or sets `A11Y_WORKER_DIR`) the launcher, if run from `node_modules`, refuses to start by design.
- **The fleet's copy still exists** in the fleet repo until the fleet row (re-export or delete) lands.

Closes: none — worker half of a11ign/a11ign#5083; the fleet re-export row and orchestrator's VERIFY row are filed separately
