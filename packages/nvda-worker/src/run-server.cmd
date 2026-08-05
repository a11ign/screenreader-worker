@echo off
rem Launch the NVDA capture worker. Invoked by the a11ysrv scheduled task, which MUST
rem use LogonType Interactive so this runs inside the logged-on desktop session (NVDA
rem is a GUI app and announces nothing without one).
rem
rem Paths derive from this script's own location (%~dp0 = ...\src\capture\nvda\) rather
rem than being hardcoded. A hardcoded C:\Users\<name>\a11y-witness breaks the moment the
rem worker is set up under a different account -- which is exactly what happens when a
rem prebuilt VM image is reused. See docs/local-worker-vm.md.
setlocal
cd /d "%~dp0..\..\.." || exit /b 1

rem Re-apply ForegroundLockTimeout for THIS session before serving. It cannot be set once
rem and forgotten: the value is cached per session and Windows does not reliably consume the
rem registry value at logon, so every worker start re-applies it via SystemParametersInfo.
rem Left non-zero, Edge is refused the foreground and every capture returns 0 phrases with
rem no error at all. Best-effort: if it fails, still start the worker (and the failure shows
rem up in diagnose-nvda-worker.ps1's Layer 5).
if exist "scripts\apply-foreground-lock-timeout.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\apply-foreground-lock-timeout.ps1" >> server.log 2>&1
)

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

rem No redirect: server.mjs writes to BOTH the console and server.log itself.
rem
rem This window is the only thing an operator sees on the guest, and it used to be blank --
rem everything went to the log, so a worker mid-capture and a wedged one looked identical.
rem A capture takes ~12s, which reads as a hang.
"%NODE_EXE%" src\capture\nvda\server.mjs
