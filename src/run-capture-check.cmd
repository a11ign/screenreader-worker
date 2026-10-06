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
rem WHERE THE REACH IS DECLARED: launcher-reach.cmd, beside this file, sets CHECKOUT_ROOT, FLT and
rem CAPTURE_CHECK. The provision stamp reads the same file, so the path is stated once. A declaration
rem that is not there stops the launcher: with no root to change into, everything below would run from
rem wherever the scheduled task started, and find nothing.
call "%~dp0launcher-reach.cmd" || exit /b 1
cd /d "%CHECKOUT_ROOT%" || exit /b 1

rem Same reason as run-server.cmd: ForegroundLockTimeout is cached per session, so without
rem re-applying it Edge is refused the foreground and every capture returns 0 phrases silently.
rem
rem ABSENT STOPS THE CHECK, and does not warn and continue as it did. A check that runs without the fix
rem reports 0 phrases and reads like a broken capture path when the cause is a file that is not there.
rem The reason goes to the log the operator reads, and the exit code is recorded the same way a verdict is.
if not exist "%FLT%" (
  echo [capture-check] ERROR: %FLT% not found under %CD% -- ForegroundLockTimeout cannot be re-applied, so the check was not run> capture-check.log
  >> capture-check.log echo EXITCODE=1
  exit /b 1
)
if not exist "%CAPTURE_CHECK%" (
  echo [capture-check] ERROR: %CAPTURE_CHECK% not found under %CD% -- the harness is missing, so the check was not run> capture-check.log
  >> capture-check.log echo EXITCODE=1
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%FLT%" > capture-check-flt.log 2>&1

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

rem A fresh log each run, and the exit code appended -- the check's verdict IS its exit status,
rem and a log that merely ends is indistinguishable from one that crashed halfway.
rem NOT %~dp0: capture-check.mjs lives in packages/lab, not beside this launcher, so the
rem sibling trick that fixes run-server.cmd does not apply here. It is found from the root the
rem declaration names, which the `cd /d` above has already put us in.
"%NODE_EXE%" "%CAPTURE_CHECK%" > capture-check.log 2>&1
>> capture-check.log echo EXITCODE=%ERRORLEVEL%
