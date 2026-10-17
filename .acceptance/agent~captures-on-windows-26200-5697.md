A capture on Windows 11 build 26200 read `["blank","blank"]` because the worker took Chrome DevTools `Page.bringToFront` as proof that Edge was in front. On worker 12 the capture's own diagnostics read `windowsActivate {ok: true, via: "cdpBringToFront"}` and then `documentReady {title: "C: WINDOWS SYSTEM 32 cmd dot exe"}`: Chromium accepted the request for its own tab, the operating system's foreground stayed on the launcher's `cmd.exe`, and NVDA started there (a11ign#5697, read from `smoke-w12.json`).

Cause named from that capture. Not yet read: why 26200 leaves the console in front where 22631 does not. That needs a 26200 box and is the host-run reading below.

The change:
- `activateBrowserWithinDeadline` no longer returns on a CDP success. The window check always runs, and `chooseActivation` (pure, in `window-focus.ts`) decides from the foreground handle READ BACK. CDP alone stands only when the check could not run (a timeout), so "could not determine" is not "refused".
- The sequence is `activateVerified` (in `window-focus.ts`, tested with fakes): the foreground is read back after EVERY route that claims success, guidepup's launcher included (review of #75). The launcher is accepted unverified only when the check could not run.
- The window script, on a refusal, retries with a synthetic Alt press and then an attached input queue, verifying the foreground after each, and reports which method won (`method`, a fourth tab field; a three-field line still parses).

Acceptance:
```bash
pnpm exec rstest run src/window-focus.test.ts
```

Result: 17/17 pass; full `pnpm test` after `pnpm run build`: 885 pass, 19 skipped; `pnpm run typecheck` and eslint on the touched files clean. Mutation, both directions, each restored byte-identical: trusting CDP always fails 3 (the 26200 test among them); never trusting CDP fails 1 (the could-not-run test); trusting the guidepup launcher fails 1 (the review's case); never accepting it fails 1 (a launcher that really worked).

NOT shown here: that a 26200 box reads the page. The Alt and attach retries are pinned by text only, since there is no Windows here. That is Done-when 2, host-run by `orchestrator`.

Closes a11ign/a11ign#5697
