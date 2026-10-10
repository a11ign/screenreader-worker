`src/launcher-reach.cmd` names `packages\lab\src\harnesses\capture-check.mjs`, which at lab `v0.1.27` is a shim that throws ("capture-check.mjs is now capture-check.ts"); lab B (a11ign#4519, step 5) deletes it. The `CAPTURE_CHECK` `set` line is the one declaration `run-capture-check.cmd` and the provision stamp both read, so it moves here once, to `capture-check.ts`.

- `src/launcher-reach.cmd`: the `CAPTURE_CHECK` line, `.mjs` to `.ts`. No other line.
- `src/layer-launchers.test.ts:95`: the absent-harness message the positive control pins names the declared path, so the literal follows. Without it this PR is red (measured: that test failed 1 of 6 before the edit, 6 of 6 after). This file is outside the row's one-file Region (`src/launcher-reach.cmd`); the row carries a comment asking `product-manager` to widen it to name this file.

Order: the layer moves first, then a11ign#4810 (the core's verbatim stand-in), then a11ign#4798 (lab deletes the shims), so the nightly `launcher-reach-drift` is never red.

Acceptance:

```bash
grep -qF 'set "CAPTURE_CHECK=packages\lab\src\harnesses\capture-check.ts"' src/launcher-reach.cmd && ! grep -qF 'capture-check.mjs' src/launcher-reach.cmd
```

Evidence (measured in this worktree at cf20643): the command above exits 0 (it exited 1 on `main`); `pnpm exec rstest run src/layer-launchers.test.ts` 6 passed; `pnpm run lint` and `pnpm run typecheck` clean; `pnpm run build && pnpm test` 745 passed, 19 skipped. The row's own Acceptance (a `curl` of `main`) can only pass after merge, and is read by the gate then.

Not covered: the rest of `src/run-capture-check.cmd:44`'s comment still says `capture-check.mjs` (a comment, outside the Region; noted on the row).

no-release: `src/launcher-reach.cmd` is read from the checkout by the launcher and the provision stamp, not shipped in the npm tarball (`files` is `dist`), so nothing should release.

Closes a11ign/agent-org#625

🤖 Generated with [Claude Code](https://claude.com/claude-code)
