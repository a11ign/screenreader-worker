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
import { powershell, USER32 } from "./powershell.ts";

/** Chromium's top-level window class, `--app` windows included. */
const CHROMIUM_CLASS = "Chrome_WidgetWin_1";

/** VK_MENU (Alt) and KEYEVENTF_KEYUP, for the synthetic key press that makes a foreground request count as input. */
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 2;

/** SW_RESTORE: un-minimise without resizing, so a restored window keeps the geometry NVDA measured. */
const SW_RESTORE = 9;

/**
 * Focus the browser window, and report which one and whether Windows granted it.
 *
 * The check is the FOREGROUND handle after the call, not the return value of `SetForegroundWindow` — the API
 * can return true having not actually changed the foreground, and this project has already been burned by a
 * verification that shared a failure mode with the action it verified.
 */
export const ACTIVATE_SCRIPT = `
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
  $method = 'plain'
  [A11yUser32]::SetForegroundWindow($best) | Out-Null
  Start-Sleep -Milliseconds 120
  if ([A11yUser32]::GetForegroundWindow() -ne $best) {
    # A plain request was refused (build 26200 leaves the launcher console in front). A synthetic Alt press
    # counts as input for the foreground rules, so ask again behind it.
    $method = 'alt'
    [A11yUser32]::keybd_event(${VK_MENU}, 0, 0, [UIntPtr]::Zero)
    [A11yUser32]::SetForegroundWindow($best) | Out-Null
    [A11yUser32]::keybd_event(${VK_MENU}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
  }
  if ([A11yUser32]::GetForegroundWindow() -ne $best) {
    # Last resort: join the holder's input queue so the request is made as the holder.
    $method = 'attach'
    $holder = [A11yUser32]::GetForegroundWindow()
    [uint32]$holdPid = 0
    $holdThread = [A11yUser32]::GetWindowThreadProcessId($holder, [ref]$holdPid)
    $ourThread = [A11yUser32]::GetWindowThreadProcessId($best, [ref]$holdPid)
    [A11yUser32]::AttachThreadInput($ourThread, $holdThread, $true) | Out-Null
    [A11yUser32]::SetForegroundWindow($best) | Out-Null
    [A11yUser32]::AttachThreadInput($ourThread, $holdThread, $false) | Out-Null
    Start-Sleep -Milliseconds 120
  }
  $fg = [A11yUser32]::GetForegroundWindow()
  "{0}\`t{1}\`t{2}\`t{3}" -f $best.ToInt64(), ($(if ($fg -eq $best) { 'FOREGROUND' } else { 'REFUSED' })), $bestTitle, $method
}
`;

/**
 * Parse the activation result.
 *
 * Pure, so it can be tested without Windows — and it is the part that decides whether a capture proceeds, so
 * a misparse would read as "there is no browser window" on a guest that has one.
 *
 * @param {string} stdout
 * @returns {{ found: boolean, foreground: boolean, title: string, handle: string, method: string }}
 */
export function parseActivation(stdout: string): { found: boolean; foreground: boolean; title: string; handle: string; method: string; } {
  const line = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (line === "NONE" || line === "") return { found: false, foreground: false, title: "", handle: "", method: "" };
  const [handle = "", state = "", title = "", method = ""] = line.split("\t");
  // A handle is always a positive integer. Anything else is PowerShell noise and must not be read as a
  // window we focused — the caller would then skip its fallback and capture an unfocused browser.
  if (!/^\d+$/.test(handle.trim())) return { found: false, foreground: false, title: "", handle: "", method: "" };
  return {
    found: true,
    foreground: state.trim() === "FOREGROUND",
    title: title.trim(),
    handle: handle.trim(),
    method: method.trim(),
  };
}

/**
 * Try to focus an existing Chromium window.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ found: boolean, foreground: boolean, title: string, handle: string, method: string, reason?: string }>}
 */
export async function focusExistingBrowserWindow(options: { timeoutMs?: number; } = {}): Promise<{ found: boolean; foreground: boolean; title: string; handle: string; method: string; reason?: string; }> {
  const result = await powershell(ACTIVATE_SCRIPT, options);
  if (!result.ok) return { found: false, foreground: false, title: "", handle: "", method: "", reason: result.reason };
  return parseActivation(result.stdout);
}

/** What `activateBrowserWithinDeadline` does next, given what the two cheap routes reported. */
export type ActivationVerdict =
  | { ok: true; via: "setForegroundWindow" | "cdpBringToFront" }
  | { ok: false; reason: string };

/**
 * Decide whether the browser is in front, from the CDP round trip AND the operating system's own answer.
 *
 * `Page.bringToFront` resolving only says Chromium accepted the request for its own tab. On Windows 11 build
 * 26200 it resolved with `via: cdpBringToFront` while the foreground stayed on the `cmd.exe` window of the
 * launcher, so NVDA started there, `documentReady` read the console's title, and every capture came back
 * `["blank","blank"]` with no error (a11ign#5697). The same capture on 22631 read the page. A CDP success is
 * therefore never the verdict: the foreground handle read back by `focusExistingBrowserWindow` is.
 *
 * CDP is accepted alone only when the operating-system check could not RUN (`reason` set): "could not
 * determine" keeps the earlier behaviour, and "refused" never shares its value.
 *
 * @param {{ ok: boolean }} cdp
 * @param {Awaited<ReturnType<typeof focusExistingBrowserWindow>>} fast
 */
export function chooseActivation(cdp: { ok: boolean; }, fast: { found: boolean; foreground: boolean; reason?: string; }): ActivationVerdict {
  if (fast.found && fast.foreground) return { ok: true, via: "setForegroundWindow" };
  if (cdp.ok && !fast.found && fast.reason) return { ok: true, via: "cdpBringToFront" };
  return { ok: false, reason: fast.found ? "SetForegroundWindow refused" : (fast.reason ?? "no Chromium window found") };
}

/** What one activation attempt reports; `via` names the route that put the browser in front. */
export type Activation = { ok: boolean; via: string; error: string; fastReason: string };

/** The side effects an activation attempt is made of, so the sequence can be tested without Windows. */
export type ActivationDeps = {
  bringToFront: () => Promise<{ ok: boolean; reason?: string }>;
  /** Bounded by the caller's own ceiling as well as the time given. */
  focusWindow: (timeoutMs: number) => Promise<Awaited<ReturnType<typeof focusExistingBrowserWindow>>>;
  /** guidepup's launching activate, already bounded by the caller; rejects on failure. */
  launchBrowser: (timeoutMs: number) => Promise<void>;
  now: () => number;
};

/**
 * Put the browser in front and prove it, by CDP, then the window check, then guidepup's launcher.
 *
 * Every route that reports success is followed by the foreground handle read back from Windows. guidepup's
 * `windowsActivate` resolving is the same kind of claim `Page.bringToFront` resolving is: a request the
 * operating system accepted, not a foreground it granted (a11ign#5697). So the launcher's success is checked
 * too, and accepted unverified only when the check itself could not run.
 *
 * @param {ActivationDeps} deps
 * @param {number} deadline epoch ms
 */
export async function activateVerified(deps: ActivationDeps, deadline: number): Promise<Activation> {
  const remaining = () => deadline - deps.now();
  if (remaining() <= 0) return { ok: false, via: "none", error: "no time left to activate", fastReason: "" };
  const cdp = await deps.bringToFront();
  const fast = await deps.focusWindow(remaining());
  const verdict = chooseActivation(cdp, fast);
  if (verdict.ok) return { ok: true, via: verdict.via, error: "", fastReason: "" };
  const fastReason = [cdp.reason ? `cdp: ${cdp.reason}` : "", verdict.reason].filter(Boolean).join("; ");
  if (remaining() <= 0) return { ok: false, via: "fast", error: "deadline spent on the fast path", fastReason };
  try {
    await deps.launchBrowser(Math.max(1_000, remaining()));
  } catch (e) {
    return { ok: false, via: "guidepup", error: e instanceof Error ? e.message : String(e), fastReason };
  }
  const after = await deps.focusWindow(Math.max(1_000, remaining()));
  if (after.found && after.foreground || !after.found && after.reason) return { ok: true, via: "guidepup", error: "", fastReason };
  const error = after.found ? "guidepup activated but the foreground is still not the browser" : "guidepup activated but no Chromium window exists";
  return { ok: false, via: "guidepup", error, fastReason };
}
