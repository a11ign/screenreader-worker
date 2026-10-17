A capture on Windows 11 build 26200 read `["blank","blank"]` because the worker took Chrome DevTools `Page.bringToFront` as proof that Edge was in front. On worker 12 the capture's own diagnostics read `windowsActivate {ok: true, via: "cdpBringToFront"}` and then `documentReady {title: "C: WINDOWS SYSTEM 32 cmd dot exe"}`: Chromium accepted the request for its own tab, the operating system's foreground stayed on the launcher's `cmd.exe`, and NVDA started there (a11ign#5697, read from `smoke-w12.json`).

Why 22631 read the page, read from the same four smoke captures (`smoke-w6/w12/w3/w14.json`, diagnostics): it did not hold the foreground either. Worker 6's FIRST pass logged the same `windowsActivate {ok:true, via:"cdpBringToFront"}` and then `documentReady {title:"Taskbar"}`, `afterStart.lastSpoken ""`, a read-through of 1 phrase (`stopReason: "silent"`) and `screenReaderMute`. `failIfScreenReaderIsMute` (`capture-pure.ts`) throws only when the transcript has at most one phrase AND NVDA was silent at start, so the worker cold-started NVDA and ran the capture again (`browserReused`, `nvdaStart {reused:false}`), and that second pass had Edge in front: `documentReady {title:"Example Domain"}`, 14 phrases. On 26200 the wrong window is the `cmd.exe` console, which NVDA speaks as "blank": `afterStart.lastSpoken "blank"`, 2 phrases (`repeatBottom`). Neither condition of the mute check holds, so no fault, no restart and no second pass, and the blank transcript is returned as a success. So the difference is not that 22631 focuses Edge (the first pass shows it does not) but that on 22631 the wrong window was SILENT and the mute recovery masked the missing foreground. Not read: why the first pass loses the foreground on either build, and whether the second pass on 22631 won it through the NVDA restart or the time; that needs a box.

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
