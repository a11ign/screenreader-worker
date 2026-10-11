@echo off
rem Launch the NVDA capture worker from the published package. This file lives at
rem node_modules\@a11ign\screenreader-worker\launcher\run-server.cmd and is invoked by the
rem a11ysrv scheduled task, which MUST use LogonType Interactive so this runs inside the
rem logged-on desktop session (NVDA is a GUI app and announces nothing without one).
rem
rem Argument 1 is the absolute path to node.exe. Provisioning resolves it from an
rem interactive elevated session and bakes it into the task. Argument 2 is the host's
rem working directory: server.log is written there and the lock script's output goes
rem there, so the choice belongs to the host, not to this package. Pass it as argument 2,
rem or set A11Y_WORKER_DIR. With neither, this refuses to start rather than guessing.
rem
rem Every path below derives from this file's own location (%~dp0), resolved to an
rem absolute path BEFORE the cd. The package can sit anywhere in node_modules, and the
rem working directory does not have to be three levels under a checkout root.
setlocal
for %%I in ("%~dp0..\dist\server.mjs") do set "SERVER=%%~fI"
for %%I in ("%~dp0apply-foreground-lock-timeout.ps1") do set "FLT=%%~fI"

set "WORK_DIR=%~2"
if not defined WORK_DIR set "WORK_DIR=%A11Y_WORKER_DIR%"
if not defined WORK_DIR (
  echo [run-server] FATAL: no working directory. Pass it as argument 2 or set A11Y_WORKER_DIR. 1>&2
  exit /b 1
)
cd /d "%WORK_DIR%" 2>nul
if errorlevel 1 (
  echo [run-server] FATAL: cannot cd to the working directory given as argument 2 or A11Y_WORKER_DIR 1>&2
  exit /b 1
)

rem Re-apply ForegroundLockTimeout for THIS session before serving. The value is cached per
rem session and Windows does not reliably consume the registry value at logon, so every
rem worker start re-applies it via SystemParametersInfo. Left non-zero, Edge is refused the
rem foreground and every capture returns 0 phrases with no error at all.
rem Best-effort: if it fails, the worker still starts and diagnose-nvda-worker.ps1's Layer 5
rem shows the failure. Absent must be LOUD, not skipped: a silent skip is the fault that
rem makes Edge lose the foreground and every capture return 0 phrases with no error.
if exist "%FLT%" powershell -NoProfile -ExecutionPolicy Bypass -File "%FLT%" >> server.log 2>&1
if not exist "%FLT%" echo [run-server] WARNING: apply-foreground-lock-timeout.ps1 not beside this launcher -- ForegroundLockTimeout NOT re-applied for this session>> server.log
if not exist "%FLT%" echo [run-server] WARNING: apply-foreground-lock-timeout.ps1 not beside this launcher -- ForegroundLockTimeout NOT re-applied for this session

rem Resolve node WITHOUT trusting the environment, because a scheduled task does not get the one
rem an interactive shell has. Measured on the first bare-metal worker: manual runs logged
rem "starting C:\Program Files\nodejs\node.exe" and served fine, while every task-launched run
rem logged "starting node" and died with 9009, '"node"' is not recognized.
rem
rem %ProgramFiles% was EMPTY in the task's environment, so the candidate became a path that
rem did not exist, and the fallback to bare node then failed because the task's PATH has no
rem node either.
rem
rem So: argument 1 wins, then several ABSOLUTE candidates, literal paths included, and PATH
rem only as a last resort.
rem
rem NO %ProgramFiles(x86)% candidate, deliberately: cmd matches the parentheses in a for-set
rem NAIVELY, and the "(x86)" in that variable name closes the set early. We install the x64
rem build, so the 32-bit locations are moot anyway.
rem An empty argument 1 leaves NODE_EXE undefined, so the search below simply runs.
set "NODE_EXE=%~1"

if not defined NODE_EXE for %%C in (
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

rem stderr goes to server.log, and that is the point. A crash at IMPORT time happens before the
rem server has written anything, so its stack would otherwise go to a console window that
rem closes with the process. stdout stays on the console window, so an operator still sees the
rem worker's own lines there; a capture takes about 12s, which reads as a hang without them.
rem The exit code is recorded too: a worker that stops is a different fact from one that never
rem started, and without this they look identical from the outside.
echo [run-server] starting %NODE_EXE% at %DATE% %TIME%>> server.log
"%NODE_EXE%" "%SERVER%" 2>> server.log
echo [run-server] node exited with %ERRORLEVEL% at %DATE% %TIME%>> server.log
