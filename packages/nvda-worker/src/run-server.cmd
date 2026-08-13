@echo off
rem Launch the NVDA capture worker. Invoked by the a11ysrv scheduled task, which MUST
rem use LogonType Interactive so this runs inside the logged-on desktop session (NVDA
rem is a GUI app and announces nothing without one).
rem
rem Paths derive from this script's own location (%~dp0) rather than being hardcoded. A
rem hardcoded C:\Users\<name>\a11y-witness breaks the moment the worker is set up under a
rem different account -- which is exactly what happens when a prebuilt VM image is reused.
rem See docs/local-worker-vm.md.
rem
rem server.mjs is addressed as "%~dp0server.mjs" -- BESIDE this file -- rather than as a path
rem from the repo root. It used to read src\capture\nvda\server.mjs, and when the repo was
rem restructured into packages/ that became a file which does not exist: node exited
rem immediately, nothing listened on 8765, and provisioning reported only "worker did not
rem listen". A sibling reference cannot rot when the tree moves.
setlocal
cd /d "%~dp0..\..\.." || exit /b 1

rem Re-apply ForegroundLockTimeout for THIS session before serving. It cannot be set once
rem and forgotten: the value is cached per session and Windows does not reliably consume the
rem registry value at logon, so every worker start re-applies it via SystemParametersInfo.
rem Left non-zero, Edge is refused the foreground and every capture returns 0 phrases with
rem no error at all. Best-effort: if it fails, still start the worker (and the failure shows
rem up in diagnose-nvda-worker.ps1's Layer 5).
rem NOT silently skipped when missing. This path was also stale after the restructure, and
rem because it sits behind `if exist` it vanished without a word -- so ForegroundLockTimeout
rem stopped being re-applied per session, which is the fault that makes Edge lose the
rem foreground and every capture return 0 phrases with NO error. Absent must be LOUD.
set "FLT=packages\\worker-fleet\\src\\provisioning\\apply-foreground-lock-timeout.ps1"
if exist "%FLT%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%FLT%" >> server.log 2>&1
) else (
  echo [run-server] WARNING: %FLT% not found -- ForegroundLockTimeout NOT re-applied for this session>> server.log
  echo [run-server] WARNING: %FLT% not found -- ForegroundLockTimeout NOT re-applied for this session
)

rem Resolve node WITHOUT trusting the environment, because a scheduled task does not get the one
rem an interactive shell has. Measured on the first bare-metal worker: manual runs logged
rem "starting C:\Program Files\nodejs\node.exe" and served fine, while every task-launched run
rem logged "starting node" and died with 9009, '"node"' is not recognized.
rem
rem %ProgramFiles% was EMPTY in the task's environment, so "%ProgramFiles%\nodejs\node.exe"
rem became "\nodejs\node.exe", `if not exist` fired, and the fallback to bare `node` then failed
rem because the task's PATH has no node either. Two environment assumptions, one silent fallback,
rem and a worker that appeared to start and vanish in two seconds.
rem
rem So: several ABSOLUTE candidates, literal paths included, and PATH only as a last resort.
rem
rem NO %ProgramFiles(x86)% candidate, deliberately: cmd matches the parentheses in a for-set
rem NAIVELY, and the "(x86)" in that variable name closes the set early -- quotes do not
rem reliably protect it. We install the x64 build, so the 32-bit locations are moot anyway.
set "NODE_EXE="
for %%C in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramW6432%\nodejs\node.exe"
  "C:\Program Files\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
) do if not defined NODE_EXE if exist "%%~C" set "NODE_EXE=%%~C"

rem LOUD, not silent. Falling back to PATH is a guess, and the last time it was made quietly it
rem cost hours: the log said "starting node" and nothing said that was a degraded choice.
if not defined NODE_EXE (
  echo [run-server] WARNING: node.exe not found in any known location; falling back to PATH>> server.log
  echo [run-server] WARNING: node.exe not found in any known location; falling back to PATH
  set "NODE_EXE=node"
)

rem No redirect: server.mjs writes to BOTH the console and server.log itself.
rem
rem This window is the only thing an operator sees on the guest, and it used to be blank --
rem everything went to the log, so a worker mid-capture and a wedged one looked identical.
rem A capture takes ~12s, which reads as a hang.
rem stderr is REDIRECTED to server.log, and that is the point rather than tidiness.
rem
rem server.mjs writes its own lines to server.log once it is running -- but a crash at IMPORT
rem time happens before any of that exists, so the stack went to a console window that closes
rem with the process. Observed: the window opened, vanished in two seconds, and server.log ended
rem at the ForegroundLockTimeout line with no hint of why. Unreadable exactly when it matters.
rem
rem The exit code is recorded too, the same way run-capture-check.cmd already does it: a worker
rem that stops is a different fact from a worker that never started, and without this they look
rem identical from the outside.
echo [run-server] starting %NODE_EXE% at %DATE% %TIME%>> server.log
"%NODE_EXE%" "%~dp0server.mjs" 2>> server.log
echo [run-server] node exited with %ERRORLEVEL% at %DATE% %TIME%>> server.log
