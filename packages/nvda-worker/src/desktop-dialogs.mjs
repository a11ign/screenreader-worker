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
import { powershell as runPowershell, USER32 } from "./powershell.mjs";

/** Standard Windows dialog class. NVDA's error boxes, Edge's prompts and Windows' own alerts all use it. */
const DIALOG_CLASS = "#32770";

/**
 * Generous, because it is measured: the enumeration costs ~2.5 s on an idle guest and consistently exceeded
 * 8 s on a loaded one — `Add-Type` compiles C#, and the guest is busiest exactly when a dialog is most likely.
 * At 8 s the detector reported "could not enumerate" on every sample of a busy worker, which is a detector
 * that switches itself off under load. It is bounded rather than unbounded because it still must never hang,
 * and it is affordable to wait: the sampler runs on a background timer and the capture-path call happens once.
 */
const PS_TIMEOUT_MS = 25_000;

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
${USER32}
$out = New-Object System.Collections.ArrayList
$top = [A11yUser32+EnumProc]{
  param($h, $p)
  if ((Get-A11yClass $h) -eq '${DIALOG_CLASS}' -and [A11yUser32]::IsWindowVisible($h)) {
    $parts = New-Object System.Collections.ArrayList
    $kid = [A11yUser32+EnumProc]{
      param($k, $q)
      $t = Get-A11yText $k
      if ($t -and $t.Length -gt 1) { $parts.Add($t) | Out-Null }
      return $true
    }
    [A11yUser32]::EnumChildWindows($h, $kid, [IntPtr]::Zero) | Out-Null
    $msg = ($parts -join ' ') -replace '\\s+', ' '
    $out.Add(("{0}${SEP}{1}${SEP}{2}" -f $h.ToInt64(), (Get-A11yText $h), $msg)) | Out-Null
  }
  return $true
}
[A11yUser32]::EnumWindows($top, [IntPtr]::Zero) | Out-Null
$out -join "\`n"
`;

/** WM_CLOSE to each handle. Equivalent to clicking the dialog's X or its default OK button. */
const closeScript = (handles) => `
${USER32}
$closed = 0
foreach ($h in @(${handles.join(",")})) {
  $r = [IntPtr]::Zero
  # SendMessageTimeout, not SendMessage: a hung dialog would block a plain send forever, and this code runs
  # on the capture path. WM_CLOSE = 0x0010, SMTO_ABORTIFHUNG = 0x0002.
  [A11yUser32]::SendMessageTimeout([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$r) | Out-Null
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
  const result = await runPowershell(script, { timeoutMs: PS_TIMEOUT_MS });
  if (result.ok) return result.stdout;
  // Degrade to "nothing found" rather than failing the caller: this is a diagnostic aid, and a capture
  // must still be attempted on a guest whose window enumeration did not work.
  onError?.(result.reason);
  return "";
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
