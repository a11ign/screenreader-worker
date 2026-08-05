# NVDA capture worker (Windows)

> **Standing up, repairing, or debugging a worker?** Use
> [`docs/nvda-worker-runbook.md`](../../../docs/nvda-worker-runbook.md) and the two
> scripts it drives — `scripts/provision-nvda-worker.ps1` (idempotent setup/repair)
> and `scripts/diagnose-nvda-worker.ps1` (read-only PASS/FAIL per layer, with the
> fix for each). The runbook also carries the error-string → real-cause table; the
> messages NVDA and guidepup emit are actively misleading. This file explains the
> mechanics and the hard-won quirks behind those scripts.

The proven recipe for driving **real NVDA** through a real browser and capturing
what it announces. This is the spike that proved the capture half of the core
bet (see `../../../docs/adr/0001-capture-architecture.md`). It is not yet the
productionised HTTP-service worker; it is the manual recipe that the bootstrap
script and Packer image will encode.

## What runs where

The capture **must run in an interactive desktop session** — NVDA is a GUI app
and needs a real desktop, a foreground browser window, and focus. A bare SSH
session has no interactive desktop, so launching the capture directly over SSH
produces empty announcements. We run it via a Scheduled Task with
`LogonType Interactive`, which executes in the logged-on user's session.

## One-time setup on the VM

Windows 11, an admin user logged into the console (so there is an interactive
session), reachable over SSH.

```powershell
# Node, Git (NVDA itself is optional: Guidepup manages its own portable copy)
winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements

# Project + deps
git clone https://github.com/DanBeckDev/a11y-witness.git
cd a11y-witness; npm install

# `setup` zeroes ForegroundLockTimeout so the browser can take focus during
# capture; `install nvda` downloads the portable NVDA build pinned in
# @guidepup/guidepup's manifest.json into %LOCALAPPDATA%\guidepup.
npx --yes @guidepup/setup setup
npx --yes @guidepup/setup install nvda   # run from the repo: it reads the LOCAL guidepup's manifest

# Guidepup ships the Speech Viewer ON, and that window's focus event lands in the
# spokenPhraseLog delta — so every interaction probe records "NVDA Speech Viewer"
# instead of the page's response, making accessible and inaccessible pages
# indistinguishable. Turn it off in the installed config (see the gotcha below).
```

> **Version pairing is not optional.** guidepup ≤0.27 reaches for the old NVDA
> Remote *add-on* (`userConfig\addons\remote\...\server.pem`); NVDA 2026.1.x ships
> Remote Access in core (`userConfig\remoteAccess\localRelay\NvdaRemoteRelay.pem`)
> and has no such add-on, so an old guidepup with a new NVDA fails at
> `NVDAClient.connect` — reported, misleadingly, as "NVDA not installed" even
> though NVDA started fine. guidepup 0.29.2 accepts both paths. It also resolves
> the install from `%LOCALAPPDATA%\guidepup` (override:
> `GUIDEPUP_SCREEN_READERS_PATH`) rather than the old
> `HKCU\Software\Guidepup\Nvda` registry pointer, which is what makes the install
> survive temp cleanup.
>
> The settings that shape the transcript (NVDA's "Report live regions" — on by
> default — "Automatic say all on page load", and the element-reporting toggles)
> come from Guidepup's bundled config. Note: "Automatic say all on page load"
> can race the line-stepping read on long pages; today the startup settle
> mitigates it (anchoring the read-through to cancel the auto-read is a backlog
> item — see PLAN.md and docs/nvda-correctness-audit.md).

## Running a capture (in the interactive session)

`run-capture.cmd <url>` runs `capture.mjs`, which launches Edge maximized, starts
NVDA, reads the page in browse mode (`nvda.next()`), and writes `transcript.json`.
Trigger it as an interactive scheduled task:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Users\<user>\a11y-witness\src\capture\nvda\run-capture.cmd" -Argument "https://example.com"
$principal = New-ScheduledTaskPrincipal -UserId "<user>" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "a11ycap" -Action $action -Principal $principal -Force
Start-ScheduledTask -TaskName "a11ycap"
```

Then collect `transcript.json` and feed it to the judge on the control plane:
`npx tsx src/lab/judge-file.ts transcript.json "<the user's task>"`.

## Gotchas learned the hard way

- **Interactive session is mandatory.** Over plain SSH, NVDA announces nothing.
- **Browser focus + timing.** Launch the browser maximized and wait ~12s before
  `nvda.start()`, or NVDA reads an empty/unfocused context.
- **Read the current item first.** `nvda.next()` moves *then* reads, so capture
  `itemText()` once at the top or the first heading is skipped.
- **Stop at the bottom.** "Read next" re-announces the last item forever on short
  pages; stop after a few identical consecutive phrases.
- **OpenSSH via Windows Update can hang.** Installing OpenSSH with
  `Add-WindowsCapability` may stall on Windows Update; installing the
  Win32-OpenSSH release from GitHub is the reliable path.
- **Focus the browser window explicitly — the #1 flakiness fix.** Do NOT rely on
  the launched browser taking the foreground. Call Guidepup's
  `windowsActivate("msedge.exe", "Edge")` before `nvda.start()`, or captures come
  back empty/partial. Use `windowsQuit` to close cleanly. This was a root cause
  of flaky captures.
- **A modal dialog silently freezes the session.** A whole-capture outage (0
  phrases even on a known-good page) was a Windows permission dialog blocking the
  interactive session, not an NVDA fault. Accept it on the console; it will not
  surface over SSH. The structured diagnostics (`afterStart.lastSpoken` empty +
  every read empty with no error) are what pinpointed it.
- **Do not manually `taskkill nvda.exe`.** Let Guidepup own NVDA's lifecycle via
  `nvda.start()` / `nvda.stop()`; killing it out from under Guidepup destabilises
  the speech-capture channel.
- **A reused NVDA can go mute — still answering keystrokes, simply not speaking.**
  Stochastic, on a survival curve: across 1,939 corpus captures ~45% of NVDA
  instances reach the 25-capture recycle (which fired 51 times), while in a tight
  loop on a memory-pressured host lifespans of 5-9 were measured. Do not
  generalise from the tight loop — an earlier version of this note did, and
  claimed the 25-recycle never fires; the corpus refutes that. Reuse is causal
  (with `reuseScreenReader:false`, 8 of 8 ran clean, at ~48s each against ~25s
  reused), so reuse stays and the worker retries once on a fresh NVDA before
  answering. If you edit this file, the thing to know is that
  `failIfScreenReaderIsMute` needs **two** signals — nothing spoken at startup
  *and* nothing heard in the read — because an empty read alone is not proof.
- **Suppress Edge's first-run experience on a fresh profile.** A brand-new Edge
  profile shows a welcome/sign-in surface despite `--no-first-run`. On a page
  with no headings (or no controls), NVDA quick-nav escapes the empty document
  into that browser UI and records it as a phantom element ("Welcome to
  Microsoft Edge…", "Sign in to sync data"). Set the documented Edge policies
  before capturing: `HideFirstRunExperience=1` and `BrowserSignin=0` under
  `HKLM\SOFTWARE\Policies\Microsoft\Edge`. An established profile (like a
  long-used VM) doesn't show it, which is why this only bit a fresh CI runner —
  see `.github/workflows/capture-regression.yml`.
- **Operate controls in place during the form-field sweep.** A separate
  next/previous sweep to find a control fails on sparse pages: after the
  structural sweep the cursor sits at the end, so "next form field" returns
  nothing — the only control is the *current* position. Activate via the sweep's
  on-item callback instead. (Also: NVDA's "B" button quick-nav misses plain
  `<button>`s that "F"/form-field nav reaches.)
- **Turn the NVDA Speech Viewer OFF, or every interaction probe is worthless.**
  Guidepup's bundled `nvda.ini` sets `[speechViewer] showSpeechViewerAtStartup =
  True`. That window's focus event is announced, so it lands in the
  `spokenPhraseLog` delta captured right after activating a control: the
  disclosure and form-submit probes both came back `after: "NVDA Speech Viewer"`
  on *every* page, so an accessible page (which announces its error) and an
  inaccessible one (which is silent) looked identical — the 3.3.1 / 4.1.3 signal
  was destroyed while `capture-check` still reported all-pass, because it asserts
  the probe *fired*, not what it heard. Set it to `False` in
  `%LOCALAPPDATA%\guidepup\nvda\all\<version>\extracted\userConfig\nvda.ini`
  after installing; a reinstall resets it. With it off: `disclosure-good` →
  `"expanded"`, `disclosure-bad` → `""`, `forms-validation-good` → `"There is a
  problem. Email address is required."`, `forms-validation-bad` → `""`.
- **A screen reader without UIAccess cannot read elevated windows.** Guidepup runs
  `nvda_noUIAccess.exe`, so do NOT "fix" permission problems by running the worker
  or the browser elevated — NVDA would go silent on that window. Elevation is also
  what summons UAC, and with `PromptOnSecureDesktop=1` that dialog lands on the
  secure desktop, where it is both unreadable by NVDA and unclickable by
  automation: fatal on a headless VM. Nothing in the capture path needs elevation.
  Set the firewall profiles' `NotifyOnListen` to `False` so a listening program can
  never raise the "allow this app" dialog either.
- **Capture the `spokenPhraseLog` delta, not just `lastSpokenPhrase`, after
  activating something.** A live-region alert (e.g. a form error) is often
  immediately followed by a focus move or document re-announce that overwrites
  `lastSpokenPhrase`, hiding the alert. Snapshot the log length before, then take
  everything announced after.

## Guidepup API reference

The authoritative API is the Guidepup docs, not the bundled `.d.ts`:
[intro](https://www.guidepup.dev/docs/intro),
[NVDA class](https://www.guidepup.dev/docs/api/class-nvda),
[Guidepup class](https://www.guidepup.dev/docs/api/class-guidepup).
Methods we rely on: `nvda.start/stop`, `next/previous` (arrow read), `perform(command)`
(quick-nav via `keyboardCommands`, e.g. `moveToNextHeading`/`moveToPreviousHeading`,
no `moveToTop`), `press(key)` (key on the focused control, e.g. "Tab"/"Space"/"Control+Home"),
`act` (Enter on the focused item), `lastSpokenPhrase`/`spokenPhraseLog`. For NVDA,
`itemText` equals `lastSpokenPhrase`. Top-level helpers: `windowsActivate`, `windowsQuit`.

## Portable NVDA: caveats (from the official NVDA user guide)

Guidepup installs and drives a **portable** copy of NVDA. Per the
[official NVDA user guide](https://download.nvaccess.org/releases/2026.1.1/documentation/userGuide.html#NavigatingWithNVDA),
portable/temporary copies have restrictions, notably **no browse mode in Windows
Store (UWP) apps**. We drive **desktop (Win32) Edge**, where browse mode works
(every capture confirms it), so this does not affect us — but the worker must
**not** be pointed at a UWP/Store-app browser, where the read-through would be
empty.

Also, a warning learned the hard way: older `@guidepup/setup` installed the
portable NVDA under `%TEMP%`, and Windows temp cleanup **silently gutted it** —
`library.zip`, `nvda_slave.exe` and `nvdaHelperLocal.dll` deleted, leaving
`nvda.exe` as a 77 KB stub that launches and dies. The symptom was
`Timed out waiting for NVDA to be running` with no `nvda.log` at all, three days
after the last good capture. guidepup 0.29.2 installs to `%LOCALAPPDATA%\guidepup`
instead, which cleanup does not touch; use `GUIDEPUP_SCREEN_READERS_PATH` if you
need it somewhere else. The old `--nvda-install-dir` flag no longer exists — the
CLI was rewritten into `setup` / `install` subcommands in 0.24.0.

Navigation model (same guide): NVDA has **browse mode** (single-letter quick-nav
by element type — h headings, d landmarks, f form fields, etc.), **focus mode**
(keystrokes go to the control; toggle with **NVDA+Space**), and **object
navigation**. The structural passes use browse-mode quick-nav; operating
controls (Layer 2 part 2) will use focus mode.

## Sample output

`../../spike/fixtures/nvda-w3c-bad-before.json` is a real capture of the W3C WAI
"Before" (deliberately inaccessible) demo. It audibly contains the real defects:
unlabelled graphics, "Click here" links, and visual headings not marked up as
headings.

## Running `capture-check` on a live worker

It refuses, and that is deliberate: NVDA is a single machine-wide resource, so the check and
the worker would drive the same screen reader and whichever finished first would stop the
other's. Stop the worker, run the check **in the interactive session** (a scheduled task —
`utmctl exec` and SSH are session 0 and report the missing desktop as `NVDA is not supported`),
then **start the worker again**, which the check does not do for you.

```powershell
Stop-ScheduledTask -TaskName a11ysrv
Get-Process node -EA SilentlyContinue | Stop-Process -Force   # note: this orphans NVDA
Start-ScheduledTask -TaskName capcheck                        # LogonType Interactive
# ... read C:\Users\<user>\capcheck.log ...
Start-ScheduledTask -TaskName a11ysrv
```
