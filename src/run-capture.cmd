@echo off
rem One-shot capture of a single URL, for the a11ycap scheduled task (interactive
rem session required, same as the worker). Writes transcript.json in the repo root.
rem
rem   run-capture.cmd https://example.com
rem
rem Was broken: it invoked `nvda-capture.mjs`, a file that has never existed in this
rem repo (the CLI is capture.mjs), against a hardcoded C:\Users\borem path. It only
rem appeared to work because an untracked copy happened to sit in one worker's repo
rem root. Both are now derived from this script's location.
setlocal
cd /d "%~dp0..\..\.." || exit /b 1

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

"%NODE_EXE%" src\capture\nvda\capture.mjs "%~1" "%CD%\transcript.json" 150 > capture.log 2>&1
echo EXITCODE %ERRORLEVEL%>> capture.log

rem Belt-and-braces: capture.mjs closes Edge via Guidepup's windowsQuit, but a crash
rem mid-capture would leave the window open and the next run reading a stale page.
rem NOTE: only ever force-kill EDGE here, never nvda.exe -- killing NVDA out from
rem under Guidepup destabilises the speech-capture channel.
taskkill /im msedge.exe /f >> capture.log 2>&1
