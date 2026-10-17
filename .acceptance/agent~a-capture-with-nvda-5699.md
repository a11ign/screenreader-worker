A capture whose screen reader is speaking a shell window, not the page, was returned as success. On Windows 11 build 26200 the launcher's `cmd.exe` held the foreground: NVDA spoke it as "blank", so `lastSpoken` was not empty and the mute check (`failIfScreenReaderIsMute`) did not fire. The read-through heard two identical phrases and the capture went through. On 22631 the taskbar held the foreground and NVDA was silent, so only the mute recovery hid the missing foreground.

The change:
- `failIfCaptureIsOnWrongWindow` (in `capture-pure.ts`, called from `runCapturePhases` right after the mute check) raises `FAULT.SCREEN_READER_MUTE` when the last `documentReady` title is a shell window's (`cmd.exe`, PowerShell, `taskbar`, `program manager`, `blank`) AND the transcript is at most two phrases with at most one distinct value.
- The title alone decides nothing: a page may be titled anything, so a page named "Taskbar setup guide" with a real transcript is not tripped.
- `SCREEN_READER_MUTE` is recoverable (`worker-recovery.ts`), so the worker cold-starts NVDA and captures again. No new fault code, since `capture-faults.ts` and `worker-recovery.ts` are outside this change.

Acceptance:
```bash
pnpm exec rstest run src/capture-pure.test.ts
```

Result: `VERDICT pass: 6 tests in 1 file`. Two of the six are the 26200 and 22631 fixtures (both expect `SCREEN_READER_MUTE`); four are controls. Mutation, each restored byte-identical: never firing fails 2 (the two wrong-window tests); always firing fails 4 (the four controls). Full `pnpm test` after `pnpm run build`: 891 passed, 19 skipped, 0 failed. `pnpm run typecheck` and eslint on the touched files: clean.

NOT shown here: that a real 26200 or 22631 box now retries into a foreground page. The fixtures are the diagnostics shapes quoted in `agent~captures-on-windows-26200-5697.md`; there is no Windows host here. And the gate knows the requested page's title only by its shell-window signature, not by comparing titles, so a wrong window whose title is not a shell window is not caught.

Closes a11ign/a11ign#5699
