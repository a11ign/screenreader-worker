@echo off
rem WHAT THE LAUNCHERS REACH OUTSIDE THIS LAYER, declared ONCE (ADR 0039 item 6d, #3397).
rem
rem `call`ed by run-capture-check.cmd, and READ AS TEXT by the provision stamp
rem (`stamp-provision-revision.ps1`), which hashes the foreground-lock script this names. Two readers of
rem one declaration is the point: the launcher used to carry its own copy of the path and the stamp
rem another, so a move could change one and leave the other pointing at a file that was not there.
rem
rem THE FORMAT IS FIXED BY THE READERS. Each value is a `set "NAME=value"` line, because cmd can `call`
rem that and PowerShell and a test can read it with one pattern. No JSON: cmd cannot parse it, and a
rem launcher that shells out to PowerShell to find a path has moved the problem into a quoting rule nobody
rem can test from a Linux host. Paths are relative to CHECKOUT_ROOT, backslash-separated.
rem
rem `run-server.cmd` is NOT a reader, deliberately and for now. The stamp HASHES that file, so editing it
rem moves `provisionRevision` on every worker and costs a full recapture. It carries the same two literals
rem it always did, and `layer-launchers.test.ts` pins them equal to the lines below. When the stamp next
rem moves for another reason, it joins this declaration then.

rem The checkout root, from THIS file's own location: src is one level under the layer, the layer is two
rem under the root (packages\LAYER\src). A layer placed at the same relative path keeps the launchers
rem byte-identical, which is what ADR 0039 item 6 decided.
set "CHECKOUT_ROOT=%~dp0..\..\.."

rem Re-applied on every start: ForegroundLockTimeout is cached per session, and left non-zero Edge is
rem refused the foreground and every capture returns 0 phrases with no error at all.
set "FLT=packages\worker-fleet\src\provisioning\apply-foreground-lock-timeout.ps1"

rem The capture-check harness, which lives in the lab package and not beside the launcher.
set "CAPTURE_CHECK=packages\lab\src\harnesses\capture-check.mjs"
