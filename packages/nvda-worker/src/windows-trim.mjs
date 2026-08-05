/**
 * Take Windows' background furniture off a capture guest, so its memory goes to Edge and NVDA.
 *
 * ## Why this exists
 *
 * Measured on a real guest (`/diagnostics.topProcesses`), the workload is a rounding error next to the
 * operating system carrying it:
 *
 *   msedge.exe  218 MB   <- the browser
 *   nvda.exe    207 MB   <- the screen reader        = 425 MB of actual work
 *   svchost.exe 889 MB across 63 processes
 *   MsMpEng     254 MB   SearchHost 185 MB
 *   explorer    144 MB   StartMenu  107 MB   CrossDevice 74 MB
 *
 * Committed bytes for the whole guest is ~1,852 MB. That number is the reason this module matters:
 * host cost scales at ~1.8-2.0x *configured* guest RAM, so every 512 MB we can take off the guest's
 * ceiling is ~1 GB back on the host — but the ceiling cannot go below what the guest commits. Dropping
 * a stock guest from 4,096 MB to 2,560 MB was measured and it **failed**: phase time went from ~20 s to
 * ~45 s because Windows started paging. Trimming the OS is what makes a lower ceiling safe. The trim is
 * not the prize; it is the thing that unlocks the prize.
 *
 * ## Why it runs here rather than in an image build
 *
 * `nano11builder` and `tiny11builder` do this offline against a mounted WIM. Two problems: both delete
 * Edge and `LanguageFeatures-Speech`/`-TextToSpeech` — the browser we capture through and the `oneCore`
 * synth NVDA is configured to use — and both are x64/en-us, while these guests are ARM64. Adapting them
 * means owning an ISO pipeline.
 *
 * Everything here works on a live guest instead, through the one channel that is known reliable:
 * `worker:deploy` pushes the file, reboots, and verifies `/health.code` over HTTP. `utmctl exec` is not
 * usable — it returns success and no output whether or not it ran.
 *
 * ## The safety property
 *
 * A guest that loses Edge or the speech stack is not a slow guest, it is a dead one, and it would fail
 * in a way that looks like the NVDA faults this project has already spent days on. So removal is an
 * explicit allow-list intersected with an explicit deny-list, `KEEP_PATTERNS` wins over
 * `REMOVABLE_APPX`, and that precedence is the first thing the tests assert.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Provisioned Appx packages that may be removed. Taken from nano11builder's list, minus anything this
 * project touches. These are the background apps that register startup tasks and keep RuntimeBroker
 * resident; none of them is reachable from a capture.
 */
export const REMOVABLE_APPX = [
  "Clipchamp.Clipchamp",
  "Microsoft.BingNews",
  "Microsoft.BingWeather",
  "Microsoft.GamingApp",
  "Microsoft.GetHelp",
  "Microsoft.Getstarted",
  "Microsoft.MicrosoftOfficeHub",
  "Microsoft.MicrosoftSolitaireCollection",
  "Microsoft.People",
  "Microsoft.PowerAutomateDesktop",
  "Microsoft.Todos",
  "Microsoft.WindowsAlarms",
  "microsoft.windowscommunicationsapps",
  "Microsoft.WindowsFeedbackHub",
  "Microsoft.WindowsMaps",
  "Microsoft.WindowsSoundRecorder",
  "Microsoft.Xbox.TCUI",
  "Microsoft.XboxGameOverlay",
  "Microsoft.XboxGamingOverlay",
  // nano11builder also removes Microsoft.XboxSpeechToTextOverlay. It is deliberately NOT here: the
  // name matches the `speech` keep-pattern, so it could never be removed anyway, and listing it would
  // imply a removal that never happens. The keep-list is intentionally blunter than it strictly needs
  // to be — leaving a few MB of Xbox captioning on disk is the correct price for a rule that cannot
  // accidentally take out NVDA's synth.
  "Microsoft.YourPhone",
  "Microsoft.ZuneMusic",
  "Microsoft.ZuneVideo",
  "MicrosoftCorporationII.MicrosoftFamily",
  "MicrosoftCorporationII.QuickAssist",
  "MicrosoftTeams",
  "MSTeams",
  "Microsoft.Windows.Copilot",
  "Microsoft.Copilot",
  "Microsoft.OutlookForWindows",
  "Microsoft.549981C3F5F10",
  // Found by enumerating a real ARM64 guest rather than copying nano11's list. This image ships with
  // only three provisioned packages -- Edge, DevHome and CrossDevice -- and none of nano11's targets
  // (Xbox, Teams, Bing, Zune, Solitaire) exist on it at all. The list above is therefore mostly inert
  // here; it is kept because it costs nothing and a future x64 image will have them.
  "Microsoft.Windows.DevHome",
  "MicrosoftWindows.CrossDevice",
];

/**
 * Never remove anything matching these, whatever else says so.
 *
 * Matched case-insensitively as substrings, and checked *after* the removable list, so adding a package
 * to both lists keeps it. Speech and TextToSpeech are here because nano11 removes them and NVDA's synth
 * is `oneCore` — that single line is the difference between a trimmed guest and a silent one. The UIA
 * and accessibility entries are here because a screen reader reads the accessibility tree; removing that
 * would produce empty transcripts that look exactly like the mute faults we have already chased.
 */
export const KEEP_PATTERNS = [
  "edge", "webview", "speech", "texttospeech", "onecore", "narrator",
  "accessib", "uiautomation", "dotnet", "netfx", "vclibs", "ui.xaml", "runtime",
];

/**
 * Services safe to disable on a capture appliance, with the reason each is here.
 *
 * Audio services are deliberately absent. Speech is captured as text over NVDA Remote rather than as
 * audio, so it is tempting to disable them — but NVDA's synth initialises against the audio stack, and
 * a synth that fails to start is indistinguishable from the mute fault. Not worth the risk for ~20 MB.
 */
export const DISABLEABLE_SERVICES = [
  { name: "WSearch", why: "Windows Search indexing — SearchHost was 185 MB and indexes nothing we use" },
  { name: "CrossDeviceService", why: "Phone Link / cross-device — 74 MB, no phone is ever paired" },
  { name: "DiagTrack", why: "connected user experiences and telemetry" },
  { name: "MapsBroker", why: "downloaded maps" },
  { name: "XblAuthManager", why: "Xbox live auth" },
  { name: "XblGameSave", why: "Xbox live save" },
  { name: "XboxNetApiSvc", why: "Xbox networking" },
  { name: "wuauserv", why: "Windows Update — the appliance must not reboot or install mid-run" },
  { name: "UsoSvc", why: "Update Orchestrator, which restarts wuauserv" },
  { name: "WaaSMedicSVC", why: "Update Medic, which repairs the two above back to enabled" },
  { name: "dmwappushservice", why: "WAP push device management" },
];

/**
 * Defender is worth ~254 MB and is the largest single removable item, but it usually cannot be removed
 * from a *running* guest: Tamper Protection blocks `Set-MpPreference` and refuses writes to the
 * WinDefend service key. That is exactly why tiny11's "core" variant does it offline against a mounted
 * image, where Tamper Protection does not apply.
 *
 * We attempt it anyway and record the outcome rather than assuming either way, because the answer
 * decides whether an offline image pipeline is worth building at all: if this is the only thing that
 * needs an ISO, ~254 MB is the entire prize for that work, and it should be judged on that.
 */
export const DEFENDER_SERVICES = ["WinDefend", "WdNisSvc", "Sense"];

const matchesKeep = (name) => KEEP_PATTERNS.some((k) => name.toLowerCase().includes(k));

/**
 * Which of the installed packages should actually be removed.
 *
 * Deliberately takes the installed list rather than assuming it: package names carry version and
 * architecture suffixes that differ between ARM64 and x64 images, which is precisely the hardcoding that
 * makes nano11builder x64-only.
 *
 * @param {string[]} installed full package names as reported by the guest
 * @returns {string[]} the subset safe to remove
 */
export function packagesToRemove(installed) {
  return installed.filter((full) => {
    if (matchesKeep(full)) return false;
    return REMOVABLE_APPX.some((prefix) => full.toLowerCase().startsWith(prefix.toLowerCase()));
  });
}

/**
 * A one-line summary of what a trim did, for the worker to report over HTTP.
 *
 * Reported rather than logged because the guest's own log is not reachable while it is down, and
 * because "did the trim actually run" has to be answerable through the channel that is always up.
 *
 * @param {{ removed?: string[], disabled?: string[], failed?: string[], skipped?: boolean,
 *           needsElevation?: boolean }} result
 */
export function trimSummary({ removed = [], disabled = [], failed = [], skipped = false, needsElevation = false }) {
  if (needsElevation) return "skipped: needs elevation (run provision-nvda-worker.ps1)";
  if (skipped) return "already trimmed";
  const parts = [`${removed.length} app(s) removed`, `${disabled.length} service(s) disabled`];
  if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).join(", ")})`);
  return parts.join(", ");
}

// --- execution ---------------------------------------------------------------
//
// Everything below touches the guest OS. It runs once, at worker boot, guarded by a marker file, and
// only on win32. It is deliberately best-effort per item: one package that refuses to uninstall must
// not stop the rest, and none of it is a precondition for serving captures.


const POWERSHELL_TIMEOUT_MS = 120_000;

function powershell(command) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: POWERSHELL_TIMEOUT_MS });
}

/**
 * Is this process elevated?
 *
 * Everything below needs it: `Get-AppxProvisionedPackage -Online`, `Remove-AppxProvisionedPackage` and
 * `sc.exe config` all fail with "The requested operation requires elevation". The worker deliberately
 * runs as a scheduled task with `RunLevel Limited` -- NVDA does not need elevation and an elevated
 * interactive task is its own problem -- so the trim cannot run from there and must not pretend to try.
 *
 * Checked up front rather than discovered by a crash on the first DISM call, which is what happened:
 * the child died on three consecutive boots and, with stdio ignored, left no trace at all.
 */
export function isElevated() {
  if (process.platform !== "win32") return false;
  try {
    const out = powershell("([Security.Principal.WindowsPrincipal]" +
      "[Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
    return out.trim().toLowerCase() === "true";
  } catch {
    return false; // cannot tell => assume not, because acting on a wrong "yes" is the costly direction
  }
}

/**
 * Try to obtain elevation the supported way: a scheduled task that runs at `RunLevel Highest`.
 *
 * `witness` IS a member of Administrators — it simply holds a UAC-filtered token, so the worker runs
 * unelevated. That is a different problem from "no permission", and Task Scheduler is the documented
 * answer to it: a task registered at Highest runs with the full admin token, and *starting* an existing
 * task requires no elevation at all.
 *
 * Deliberately NOT a UAC bypass. If Windows refuses to register an elevated task from an unelevated
 * caller, that refusal is the answer and it is reported — the fallback is running
 * `provision-nvda-worker.ps1` elevated once, which registers the task from a context that certainly
 * can. `-Verb RunAs` is not used either: `ConsentPromptBehaviorAdmin=5` with
 * `PromptOnSecureDesktop=1` puts the prompt on the secure desktop, where nothing automated can (or
 * should) answer it.
 *
 * @returns {{ registered: boolean, started: boolean, reason: string }}
 */
export function runTrimViaElevatedTask({ scriptPath, markerPath, taskName = "a11ytrim" }) {
  const user = "$([Security.Principal.WindowsIdentity]::GetCurrent().Name)";
  const register =
    `$a = New-ScheduledTaskAction -Execute '${process.execPath}' ` +
    // The inner double quotes are for PowerShell, not for JS: they must survive into the
    // single-quoted -Argument value so a path containing a space stays one argument.
    `-Argument '"${scriptPath}" "${markerPath}"'; ` +
    `$p = New-ScheduledTaskPrincipal -UserId "${user}" -LogonType Interactive -RunLevel Highest; ` +
    "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30); " +
    `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Principal $p -Settings $s -Force | Out-Null; ` +
    `Start-ScheduledTask -TaskName '${taskName}'`;
  try {
    powershell(register);
    return { registered: true, started: true, reason: `started '${taskName}' at RunLevel Highest` };
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? "").split("\n")[0].slice(0, 300);
    return { registered: false, started: false, reason: `could not register an elevated task: ${detail}` };
  }
}

/** Provisioned Appx package names currently on the image. */
function installedProvisionedPackages() {
  const out = powershell(
    "Get-AppxProvisionedPackage -Online | ForEach-Object { $_.PackageName }");
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Remove background apps and disable services that no capture can reach.
 *
 * @param {{ markerPath: string, log?: (line: string) => void }} options
 * @returns {{ removed: string[], disabled: string[], failed: string[], skipped: boolean }}
 */
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * Has the trim actually finished, as opposed to merely having been attempted?
 *
 * A marker saying "skipped: needs elevation" is a record of *not* having run, and treating its mere
 * existence as completion is what stopped the escalation path from ever being tried: the first
 * unelevated attempt wrote a marker, and every boot afterwards read that marker and returned early.
 * "Attempted" and "done" have to read differently here for the same reason they do in `trimSummary`.
 */
export function trimAlreadyDone(markerPath) {
  try {
    return !/needs elevation/i.test(readFileSync(markerPath, "utf8"));
  } catch {
    return false; // no marker at all means not done
  }
}

export function applyWindowsTrim({ markerPath, log = () => {} }) {
  const result = { removed: [], disabled: [], failed: [], skipped: false, needsElevation: false };
  if (process.platform !== "win32" || trimAlreadyDone(markerPath)) {
    result.skipped = true;
    return result;
  }
  if (!isElevated()) {
    result.needsElevation = true;
    result.skipped = true;
    // `witness` is an administrator holding a UAC-filtered token, so elevation is obtainable through
    // Task Scheduler rather than unreachable. Try that before giving up.
    const escalation = runTrimViaElevatedTask({ scriptPath: SELF_PATH, markerPath });
    result.escalation = escalation;
    if (escalation.started) {
      // The marker is deliberately NOT written here: the elevated run writes it after doing the work,
      // and writing it now would make that run skip itself.
      log(`trim: unelevated, handed off — ${escalation.reason}`);
      return result;
    }
    log(`trim: skipped — ${escalation.reason}. Run scripts/provision-nvda-worker.ps1 elevated instead.`);
    writeFileSync(markerPath,
      `${new Date().toISOString()} skipped: needs elevation — ${escalation.reason}\n`, "utf8");
    return result;
  }
  for (const pkg of packagesToRemove(installedProvisionedPackages())) {
    try {
      powershell(`Remove-AppxProvisionedPackage -Online -PackageName '${pkg}' -ErrorAction Stop`);
      result.removed.push(pkg);
    } catch (error) {
      // Some provisioned packages are in use or system-locked. Recorded, never fatal.
      result.failed.push(pkg.split("_")[0]);
      log(`trim: could not remove ${pkg}: ${error.message.split("\n")[0]}`);
    }
  }
  for (const { name } of DISABLEABLE_SERVICES) {
    try {
      // Two calls, not one compound command. PowerShell returns the LAST command's exit code, so
      // `sc.exe stop` failing on an already-stopped service masked a `config` that had succeeded --
      // reported as "8 failed" when five services were in fact disabled correctly.
      powershell(`sc.exe config ${name} start= disabled`);
      result.disabled.push(name);
    } catch (error) {
      result.failed.push(name);
      log(`trim: could not disable ${name}: ${error.message.split("\n")[0]}`);
      continue;
    }
    try {
      powershell(`sc.exe stop ${name}`);
    } catch {
      // Already stopped, or not stoppable on demand. The disable is what matters and it is done;
      // the service will not come back after a reboot.
      log(`trim: ${name} disabled but not stopped now (it will not start again after a reboot)`);
    }
  }
  writeFileSync(markerPath, `${new Date().toISOString()} ${trimSummary(result)}\n`, "utf8");
  log(`trim: ${trimSummary(result)}`);
  return result;
}

/**
 * Try to disable Defender, and report honestly whether Tamper Protection allowed it.
 *
 * Separate from `applyWindowsTrim` because it is the one item expected to fail, and the answer is a
 * decision input rather than housekeeping: if it fails, ~254 MB is the whole return on building an
 * offline image pipeline, and that is a much weaker case than "Windows overhead is 1.4 GB".
 *
 * @returns {{ disabled: boolean, reason: string }}
 */
export function tryDisableDefender() {
  if (process.platform !== "win32") return { disabled: false, reason: "not windows" };
  try {
    powershell("Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction Stop");
  } catch (error) {
    return { disabled: false, reason: `Tamper Protection refused: ${error.message.split("\n")[0]}` };
  }
  try {
    const state = powershell("(Get-MpComputerStatus).RealTimeProtectionEnabled").trim();
    return state.toLowerCase() === "false"
      ? { disabled: true, reason: "real-time protection off" }
      : { disabled: false, reason: `accepted the setting but still reports enabled (${state})` };
  } catch (error) {
    return { disabled: false, reason: `could not confirm: ${error.message.split("\n")[0]}` };
  }
}

/**
 * Run as a detached one-shot: `node windows-trim.mjs <markerPath>`.
 *
 * A module and a CLI in one file so the trim ships through `worker:deploy` like everything else, with
 * no extra file to add to the code hash and no second delivery mechanism to get wrong.
 *
 * Detached rather than inline at worker boot because the work is minutes of PowerShell, all of it
 * synchronous, and the worker must keep answering `/health` throughout — `worker-ctl.sh up` and
 * `worker:deploy` both gate on that endpoint, so a blocking trim would present as a failed deploy.
 */
if (process.argv[1]?.endsWith("windows-trim.mjs")) {
  const marker = process.argv[2];
  if (!marker) {
    process.stderr.write("usage: node windows-trim.mjs <marker-path>\n");
    process.exit(2);
  }
  const write = (line) => process.stdout.write(`${line}\n`);
  const trim = applyWindowsTrim({ markerPath: marker, log: write });
  const defender = tryDisableDefender();
  write(`defender: ${defender.disabled ? "disabled" : "NOT disabled"} — ${defender.reason}`);
  writeFileSync(`${marker}.json`, JSON.stringify({ ...trim, defender }, null, 2) + "\n", "utf8");
}
