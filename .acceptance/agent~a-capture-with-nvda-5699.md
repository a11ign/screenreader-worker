A capture whose screen reader is speaking a shell window, not the page, was returned as success. On Windows 11 build 26200 the launcher's `cmd.exe` held the foreground: NVDA spoke it as "blank", so `lastSpoken` was not empty and the mute check (`failIfScreenReaderIsMute`) did not fire. The read-through heard two identical phrases and the capture went through. On 22631 the taskbar held the foreground and NVDA was silent, so only the mute recovery hid the missing foreground.

The change:
- `failIfCaptureIsOnWrongWindow` (in `capture-pure.ts`, called from `runCapturePhases` right after the mute check) raises `FAULT.SCREEN_READER_MUTE` when the last `documentReady` title (NVDA's spoken window title) does not contain the requested page's own document title, AND the transcript is at most two phrases with at most one distinct value. Both comparisons are case-insensitive and whitespace-normalised.
- The page's title is read over CDP (`documentTitle()` in `browser-session.ts`) by `requestedPageTitle()` in `capture-core.ts`. It is treated as unknown, and the check falls back to the shell-window signature (`cmd.exe`, PowerShell, `taskbar`, `program manager`, `blank`), when the read did not return a title or the target is suspect (`focusTargetIsSuspect`).
- The title alone decides nothing. A page may be titled anything: a page named "Taskbar setup guide" whose window reads back its own title, with a real transcript, is not tripped.
- `SCREEN_READER_MUTE` is recoverable (`worker-recovery.ts`), so the worker cold-starts NVDA and captures again. No new fault code, since `capture-faults.ts` and `worker-recovery.ts` are outside this change.

Acceptance:
```bash
pnpm exec rstest run src/capture-pure.test.ts
```

Result: `VERDICT pass: 10 tests in 1 file`. Three are wrong-window faults: the 26200 and 22631 fixtures, and a non-shell "Settings" window read as two identical phrases (all expect `SCREEN_READER_MUTE`). Two more pin the no-page-title fallback: the console still faults by its shell signature, and "Settings" is not tripped. Five are controls: the page's own title with a real transcript, a page titled "Taskbar setup guide", a page titled "cmd.exe reference" with three phrases, the page's title reading as two identical phrases, and a retry whose last read reached the page.

Mutation, each restored byte-identical: never firing fails 4 (the three faults and the console fallback); always firing fails 6 (the five controls and the "Settings" fallback control); firing on the shell signature only fails 1 (the non-shell "Settings" fault), which is the case the page-title comparison exists for. Full `pnpm test` after `pnpm run build`: `VERDICT pass: 895 tests in 99 files (19 skipped)`. `pnpm run typecheck` and eslint on the touched files: clean.

NOT shown here: that a real 26200 or 22631 box now retries into a foreground page. The fixtures are the diagnostics shapes quoted in `agent~captures-on-windows-26200-5697.md`; there is no Windows host here. And when the page title is unavailable or the target is suspect, the check falls back to shell signatures only, so a non-shell wrong window is not caught on that path.

Closes a11ign/a11ign#5699
