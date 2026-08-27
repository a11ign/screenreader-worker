// @ts-check
/**
 * One bounded, asynchronous PowerShell runner, shared by everything on the guest that needs Windows APIs.
 *
 * Two rules are baked in here so no caller can get them wrong, because both have already cost this project a
 * working worker:
 *
 * 1. **Never synchronous.** `execFileSync` blocks Node's event loop for as long as the child runs, so a
 *    worker doing it cannot answer `/health` — it looks dead while being perfectly healthy. `/diagnostics`
 *    does this and hangs; the first version of the dialog detector did it and took `/health` down within one
 *    deploy.
 * 2. **Always bounded.** An unbounded child is how a capture ran 342 seconds past its own 280-second deadline:
 *    the deadline bounded the retry LOOP while the call inside it could block forever, so the deadline was
 *    never re-evaluated. A timeout on the loop is not a timeout on the work.
 *
 * Failure degrades to `{ ok: false, reason }` rather than throwing. Everything reached through here is a
 * Windows facility we are asking about, not a step the capture depends on, and a broken enquiry must never be
 * mistaken for a broken page.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorText } from "./error-text.mjs";

const run = promisify(execFile);

/** Enough for an `Add-Type` compile on a small guest, short enough never to sit inside a capture budget. */
export const DEFAULT_PS_TIMEOUT_MS = 8_000;

/**
 * Run a PowerShell command, bounded, and report rather than throw.
 *
 * @param {string} command
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, stdout: string } | { ok: false, reason: string, stdout: "" }>}
 */
export async function powershell(command, { timeoutMs = DEFAULT_PS_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    // STDERR, not `error.message`. `execFile`'s message is just the command line it ran, so a failing script
    // reports its own source and nothing about what went wrong — the first version of this pasted 40 lines of
    // C# into a diagnostic mark and said nothing. `diagnostics.mjs` documents this same trap; I walked into it
    // anyway, one module later. Truncated because a mark is read by a human.
    // `execFile` rejects with an Error CARRYING extra fields, which `unknown` cannot express — so the
    // shape is named here rather than reached for blindly. `errorText` handles the message half.
    const failure = /** @type {{stderr?: unknown, killed?: unknown, signal?: unknown}} */ (error ?? {});
    const stderr = String(failure.stderr ?? "").replace(/\s+/g, " ").trim();
    const killed = failure.killed || failure.signal ? `timed out after ${timeoutMs}ms` : "";
    const reason = [killed, stderr].filter(Boolean).join(": ").slice(0, 400)
      || errorText(error).slice(0, 200);
    return { ok: false, reason, stdout: "" };
  }
}

/**
 * The `Add-Type` preamble for the user32 calls the worker needs.
 *
 * Shared so both callers compile the SAME type in the same way. Two copies would compile two types with the
 * same name in one session if a script ever ran them together, and the second would fail — a failure that
 * would read as "the window is gone" rather than "the script is wrong".
 */
export const USER32 = `
$ErrorActionPreference = 'Stop'
if (-not ("A11yUser32" -as [type])) {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class A11yUser32 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
}
"@
}
function Get-A11yText($h) {
  $b = New-Object System.Text.StringBuilder 1024
  [A11yUser32]::GetWindowText($h, $b, 1024) | Out-Null
  return $b.ToString()
}
function Get-A11yClass($h) {
  $b = New-Object System.Text.StringBuilder 256
  [A11yUser32]::GetClassName($h, $b, 256) | Out-Null
  return $b.ToString()
}
`;
