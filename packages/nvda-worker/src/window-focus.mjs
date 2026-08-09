/**
 * Bring the browser window to the foreground — bounded, and without enumerating processes.
 *
 * ## The failure this replaces
 *
 * `windowsActivate` from guidepup was the largest phase of a capture (~10 s of ~25 s) and on the first real
 * website this tool was pointed at it did not finish at all: the capture reached `browserReady` at 13.9 s and
 * was abandoned at the 280 s hard timeout, with the activation finally completing around 342 s.
 *
 * Read guidepup's implementation and the reason is plain. `activate` exists to **open the application if it is
 * not already running**, and to decide that it runs a WMI query:
 *
 *     Select * from Win32_Process where ExecutablePath like '%msedge.exe%'
 *
 * then a nested `PowerShell -Command "... (Get-Process msedge) ..."` through `WshShell.Run(..., 0, True)`,
 * all inside a `cscript` child that `runVbsScript` spawns with **no timeout**. A heavy page has Edge running
 * dozens of renderer processes, so a `LIKE '%...%'` scan of `Win32_Process` and a `Get-Process` enumeration
 * both get slow — and nothing bounds either of them.
 *
 * The insight that makes this cheap: **we do not need any of the launching**. `openPage` has already started
 * Edge and waited for it over the DevTools Protocol before focus is ever requested, so the only job left is to
 * focus a window that is known to exist. Focusing a window needs no process enumeration at all — enumerate
 * windows, match the class, call `SetForegroundWindow`.
 *
 * ## Why the class and not the title
 *
 * Chromium's top-level windows are class `Chrome_WidgetWin_1`, and the title is the DOCUMENT title, which is
 * whatever page happens to be loaded — including the empty string before first paint. Matching "Edge" in the
 * title is what guidepup does and it is unreliable for `--app` windows, which carry no browser chrome and
 * therefore no "Edge" suffix. The class is stable; the title is content.
 *
 * ## What this deliberately does NOT do
 *
 * It does not launch a browser, and it does not fail a capture when it cannot focus one. `focusBrowserWindow`
 * keeps guidepup's activate as a fallback for the case where no Chromium window exists yet — bounded, this
 * time. Note also that `SetForegroundWindow` can legitimately refuse (Windows only grants the foreground to a
 * process that already has it, or during input), which is exactly why `ForegroundLockTimeout` is set to 0 on
 * these guests; a refusal is reported, not thrown.
 */
import { powershell, USER32 } from "./powershell.mjs";

/** Chromium's top-level window class, `--app` windows included. */
const CHROMIUM_CLASS = "Chrome_WidgetWin_1";

/** SW_RESTORE: un-minimise without resizing, so a restored window keeps the geometry NVDA measured. */
const SW_RESTORE = 9;

/**
 * Focus the browser window, and report which one and whether Windows granted it.
 *
 * The check is the FOREGROUND handle after the call, not the return value of `SetForegroundWindow` — the API
 * can return true having not actually changed the foreground, and this project has already been burned by a
 * verification that shared a failure mode with the action it verified.
 */
const ACTIVATE_SCRIPT = `
${USER32}
$best = [IntPtr]::Zero
$bestTitle = ''
$cb = [A11yUser32+EnumProc]{
  param($h, $p)
  if ([A11yUser32]::IsWindowVisible($h) -and (Get-A11yClass $h) -eq '${CHROMIUM_CLASS}') {
    $t = Get-A11yText $h
    # A titled window beats an untitled one: Chromium keeps hidden helper windows of the same class, and
    # focusing one of those would leave the real page unfocused while reporting success.
    if ($best -eq [IntPtr]::Zero -or ($t -and -not $bestTitle)) { $script:best = $h; $script:bestTitle = $t }
  }
  return $true
}
[A11yUser32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($best -eq [IntPtr]::Zero) { 'NONE' } else {
  [A11yUser32]::ShowWindow($best, ${SW_RESTORE}) | Out-Null
  [A11yUser32]::SetForegroundWindow($best) | Out-Null
  Start-Sleep -Milliseconds 120
  $fg = [A11yUser32]::GetForegroundWindow()
  "{0}\`t{1}\`t{2}" -f $best.ToInt64(), ($(if ($fg -eq $best) { 'FOREGROUND' } else { 'REFUSED' })), $bestTitle
}
`;

/**
 * Parse the activation result.
 *
 * Pure, so it can be tested without Windows — and it is the part that decides whether a capture proceeds, so
 * a misparse would read as "there is no browser window" on a guest that has one.
 *
 * @param {string} stdout
 * @returns {{ found: boolean, foreground: boolean, title: string, handle: string }}
 */
export function parseActivation(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (line === "NONE" || line === "") return { found: false, foreground: false, title: "", handle: "" };
  const [handle = "", state = "", title = ""] = line.split("\t");
  // A handle is always a positive integer. Anything else is PowerShell noise and must not be read as a
  // window we focused — the caller would then skip its fallback and capture an unfocused browser.
  if (!/^\d+$/.test(handle.trim())) return { found: false, foreground: false, title: "", handle: "" };
  return {
    found: true,
    foreground: state.trim() === "FOREGROUND",
    title: title.trim(),
    handle: handle.trim(),
  };
}

/**
 * Try to focus an existing Chromium window.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ found: boolean, foreground: boolean, title: string, handle: string, reason?: string }>}
 */
export async function focusExistingBrowserWindow(options = {}) {
  const result = await powershell(ACTIVATE_SCRIPT, options);
  if (!result.ok) return { found: false, foreground: false, title: "", handle: "", reason: result.reason };
  return parseActivation(result.stdout);
}
