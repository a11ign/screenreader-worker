The worker reports the Edge-updater guard's record in `/health` (a11ign#5021, item 3 of a11ign#4405): `src/edge-updater-guard.ts` (new, guidepup-free) reads `C:\ProgramData\a11ign\edge-updater-guard.json`, the file the elevated `a11y-edge-updater-guard` task writes (a11ign/control#52), and returns `{state, checkedAt, reenabled}` with `state` one of `ok`, `drift`, `stale`, `absent`, `unknown`; `src/server.ts` samples it on the version timer's tick and serves it as `environment.edgeUpdaterGuard`. The worker runs unelevated and cannot read Edge's update tasks, so a re-enabled updater was unreadable from the fleet. The fleet's half (`screenreader-fleet`, `REPORTED_ONLY`) is the second pull request on this row, and it carries the same `Closes`.

Acceptance:

```bash
git grep -q "edgeUpdaterGuard" -- src/server.ts
pnpm exec rstest run src/edge-updater-guard.test.ts
```

Evidence (measured in this worktree at the head of this branch): the rstest command exits 0 with 12 tests passing in `src/edge-updater-guard.test.ts`, which did not exist on `main`; `pnpm run lint` and `pnpm run typecheck` clean; `pnpm run build && pnpm exec rstest run` -> 826 tests in 94 files passed, 19 skipped. Before `src/worker-files.ts` named the new file, `src/code-version.test.ts` refused it (`server.ts imports edge-updater-guard.ts but it is not in the code-version hash`): that is the guard working.

Mutation: each break turned its own test(s) red and no test outside `src/edge-updater-guard.test.ts` (12 mutations, each restored byte-identical and diffed): never stale (3 tests fail); always stale (6); drift never reported (3); ENOENT never `absent` (2); every read failure `absent` (2); the BOM not stripped (2); a missing `reenabled` read as an empty one (1); no refusal of a timestamp from the future (1); a future timestamp tolerated by zero (1); the refresh dropped from the sampler's tick (1); the initial value `ok` instead of `unknown` (1); `edgeUpdaterGuard` dropped from `currentEnvironment` (1).

Not verified here: a real guest's record. The reader is run for real against fixture records, an injected clock and the real filesystem, and `server.ts` (which needs guidepup and a screen reader) is read off the source, as `windows-build.test.ts` does; that a provisioned box's guard wrote a record this reads is a fleet reading, and it is `orchestrator`'s. `Set-Content -Encoding UTF8` on Windows PowerShell 5.1 writes a BOM, which the reader strips (pinned with a fixture), and that behaviour is read from documentation here, not from a box.

Outside-Region: src/worker-files.ts — `src/code-version.test.ts` walks the imports of the shipped files and refuses one that is not in `WORKER_FILES`; the new module has to be listed or the guest's code hash does not cover a file it runs.

Closes a11ign/a11ign#5021
