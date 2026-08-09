/**
 * A modal dialog on the guest desktop blocks input, and therefore blocks every capture.
 *
 * This is the fault that has cost this project the most time while being the least visible. A modal is not a
 * slow capture and not a broken screen reader: `/health` keeps answering, `ready` keeps saying true, and every
 * capture drives NVDA into a desktop that cannot receive input until the hard timeout abandons it. From
 * outside it is indistinguishable from a guest that has run out of CPU — which is exactly how it was
 * misdiagnosed, twice, on the first real website this tool was ever pointed at.
 *
 * The specimen that prompted this module, photographed on the guest desktop:
 *
 *     Error
 *     Couldn't terminate existing NVDA process, abandoning start:
 *     Exception: [WinError 5] Access is denied.                          [ OK ]
 *
 * `CLAUDE.md` already documents ONE dialog of this kind — `nvdaHelperRemote (injection_terminate)` — and the
 * remedy recorded for it is "do not restart NVDA repeatedly". That is advice about a cause. It does nothing
 * about the state once a dialog is up, and it only names one dialog out of however many NVDA and Windows can
 * produce. So this detects the CLASS rather than the message: any visible window of the standard Windows
 * dialog class is a modal that will stop a capture, whatever it says.
 *
 * ## Why detection and dismissal are separate
 *
 * Detection is reported through `/health`, but it is **sampled on a timer, not performed on request** — the
 * first version enumerated windows inside the readiness path and `/health` stopped answering, because
 * `Add-Type` compiles C# and the request was waiting on it. "Safe to poll" was the wrong claim and it broke
 * the endpoint it was meant to improve. Dismissal has a side effect, so it happens where a side effect is
 * expected: at the start of a capture, the one moment we know the desktop must be clear. Putting dismissal in
 * a polled endpoint would rebuild the health-driven-restart loop this repo's notes blame for wedging a guest.
 *
 * ## Why it cannot hang
 *
 * Every call is bounded and every failure degrades to "none found", because `/diagnostics` taught this the
 * hard way: it walks the Edge profile and shells out, and on a loaded guest it hangs — so the endpoint meant
 * for diagnosing a wedged worker was unusable precisely when the worker was wedged, and took the worker with
 * it. A detector that can hang is worse than no detector.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Standard Windows dialog class. NVDA's error boxes, Edge's prompts and Windows' own alerts all use it. */
const DIALOG_CLASS = "#32770";

/** Bounded hard: this runs on the capture path, and a detector may never become the thing that hangs. */
const PS_TIMEOUT_MS = 8_000;

/** Field separator for the PowerShell output. Tab, because dialog text contains almost everything else. */
const SEP = "\t";

/**
 * PowerShell that lists visible dialog windows with their message text.
 *
 * The child-window text matters more than the title: every one of these dialogs is titled "Error" or
 * "NVDA", and the message is what identifies which fault occurred. `EnumChildWindows` collects the static
 * labels, which is where the message lives.
 */
const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class A11yWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
function Get-Text($h) {
  $b = New-Object System.Text.StringBuilder 1024
  [A11yWin]::GetWindowText($h, $b, 1024) | Out-Null
  return $b.ToString()
}
$out = New-Object System.Collections.ArrayList
$top = [A11yWin+EnumProc]{
  param($h, $p)
  $c = New-Object System.Text.StringBuilder 256
  [A11yWin]::GetClassName($h, $c, 256) | Out-Null
  if ($c.ToString() -eq '${DIALOG_CLASS}' -and [A11yWin]::IsWindowVisible($h)) {
    $parts = New-Object System.Collections.ArrayList
    $kid = [A11yWin+EnumProc]{
      param($k, $q)
      $t = Get-Text $k
      if ($t -and $t.Length -gt 1) { $parts.Add($t) | Out-Null }
      return $true
    }
    [A11yWin]::EnumChildWindows($h, $kid, [IntPtr]::Zero) | Out-Null
    $msg = ($parts -join ' ') -replace '\\s+', ' '
    $out.Add(("{0}${SEP}{1}${SEP}{2}" -f $h.ToInt64(), (Get-Text $h), $msg)) | Out-Null
  }
  return $true
}
[A11yWin]::EnumWindows($top, [IntPtr]::Zero) | Out-Null
$out -join "\`n"
`;

/** WM_CLOSE to each handle. Equivalent to clicking the dialog's X or its default OK button. */
const closeScript = (handles) => `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class A11yClose {
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
}
"@
$closed = 0
foreach ($h in @(${handles.join(",")})) {
  $r = [IntPtr]::Zero
  # SendMessageTimeout, not SendMessage: a hung dialog would block a plain send forever, and this code runs
  # on the capture path. WM_CLOSE = 0x0010, SMTO_ABORTIFHUNG = 0x0002.
  [A11yClose]::SendMessageTimeout([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$r) | Out-Null
  $closed += 1
}
"CLOSED $closed"
`;

/**
 * Parse the lister's output into dialog records.
 *
 * Pure, and separated from the shelling out so it can be tested without Windows — the only part of this
 * module a unit test can reach, and the part most likely to be wrong.
 *
 * @param {string} stdout
 * @returns {{handle:string,title:string,message:string}[]}
 */
export function parseDialogList(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [handle, title = "", message = ""] = line.split(SEP);
      return { handle: handle.trim(), title: title.trim(), message: message.trim() };
    })
    // A handle is always a positive integer. Anything else is PowerShell noise (a warning, a progress
    // record) and must not be reported as a dialog — a false "the desktop is blocked" would take a healthy
    // worker out of service.
    .filter((d) => /^\d+$/.test(d.handle));
}

/**
 * Run PowerShell, bounded, ASYNCHRONOUSLY, and never throw. Returns "" if it could not be run.
 *
 * Async is not a style preference here, it is the whole reason this works. The first version used
 * `execFileSync`, which blocks Node's event loop for as long as PowerShell takes — and `Add-Type` compiles C#
 * on first use, which on this guest is seconds. Wiring that into the readiness path made `/health` stop
 * answering altogether: the worker was not busy, it was blocked inside a synchronous child process. That is
 * the same defect `/diagnostics` has, reproduced faithfully, one endpoint later. Nothing on a polled path may
 * ever block the loop.
 */
async function powershell(script, onError) {
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // Degrade to "nothing found" rather than failing the caller: this is a diagnostic aid, and a capture
    // must still be attempted on a guest whose window enumeration did not work.
    onError?.(error instanceof Error ? error.message : String(error));
    return "";
  }
}

/**
 * Visible modal dialogs on the guest desktop, if any.
 *
 * @param {(reason: string) => void} [onError]
 * @returns {{handle:string,title:string,message:string}[]}
 */
export async function listBlockingDialogs(onError) {
  return parseDialogList(await powershell(LIST_SCRIPT, onError));
}

/**
 * Close every visible dialog, and report what was there.
 *
 * Returns the dialogs it tried to close, so the caller can record WHICH fault was blocking the desktop. That
 * record is the whole point: dismissing the dialog silently would fix the capture and destroy the evidence of
 * why the guest was stuck, and this project has been bitten by remedies that left no trace.
 *
 * @param {(reason: string) => void} [onError]
 * @returns {{dismissed:{handle:string,title:string,message:string}[]}}
 */
export async function dismissBlockingDialogs(onError) {
  const dialogs = await listBlockingDialogs(onError);
  if (dialogs.length === 0) return { dismissed: [] };
  await powershell(closeScript(dialogs.map((d) => d.handle)), onError);
  return { dismissed: dialogs };
}
