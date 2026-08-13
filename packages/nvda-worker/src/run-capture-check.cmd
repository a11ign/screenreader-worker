@echo off
rem Run capture-check inside the logged-on desktop session.
rem
rem Invoked by the a11ycheck scheduled task, which MUST use LogonType Interactive. `utmctl exec`
rem and SSH land in session 0, where Guidepup reports NVDA's absence as
rem "nvda.start failed: NVDA is not supported" -- which reads like a broken install and is not
rem one. The runbook has always said to run this check via a scheduled task; this is that task's
rem action, so nobody has to reconstruct it under pressure.
rem
rem Stop the worker first (`Stop-ScheduledTask -TaskName a11ysrv`) and start it again afterwards:
rem NVDA is one machine-wide resource and whichever driver finishes first stops the other's
rem screen reader. capture-check refuses to run while the worker answers /health.
setlocal
cd /d "%~dp0..\..\.." || exit /b 1

rem Same reason as run-server.cmd: ForegroundLockTimeout is cached per session, so without
rem re-applying it Edge is refused the foreground and every capture returns 0 phrases silently.
set "FLT=packages\\worker-fleet\\src\\provisioning\\apply-foreground-lock-timeout.ps1"
if exist "%FLT%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%FLT%" > capture-check-flt.log 2>&1
) else (
  echo [capture-check] WARNING: %FLT% not found -- ForegroundLockTimeout NOT re-applied> capture-check-flt.log
)

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

rem A fresh log each run, and the exit code appended -- the check's verdict IS its exit status,
rem and a log that merely ends is indistinguishable from one that crashed halfway.
rem NOT %~dp0: capture-check.mjs lives in packages/lab, not beside this launcher, so the
rem sibling trick that fixes run-server.cmd does not apply here. Relative to the repo
rem root, which is where the `cd /d` above has already put us.
"%NODE_EXE%" "packages\lab\src\harnesses\capture-check.mjs" > capture-check.log 2>&1
echo EXITCODE=%ERRORLEVEL%>> capture-check.log
