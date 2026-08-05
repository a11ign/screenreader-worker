/**
 * Put the mouse pointer somewhere it cannot change what the page renders.
 *
 * ## Why a capture has to OWN the pointer
 *
 * Nothing in this pipeline moved the mouse, so it sat wherever Windows last left it for the whole
 * capture — and a resting pointer is not a bystander. It holds CSS `:hover` state and keeps firing the
 * page's own mouse handlers, so a nav item underneath it opens its dropdown and NVDA reads that
 * dropdown's links as part of the document. The link count moves, the transcript moves, and nothing
 * anywhere records that a mouse caused it.
 *
 * That is the U+FFFC autofill artefact again in a different costume: evidence that differs between two
 * runs for a reason unrelated to accessibility. A good/bad pair captured with the pointer resting in
 * two different places is not a comparison.
 *
 * ## The observed instance, which is what turned this from theory into a fix
 *
 * Edge's "Magnify image" opens on **Ctrl pressed twice while the pointer is over an image**, and
 * guidepup sends Ctrl (`keyCodeCommands.stopSpeech`, from its `#stopReading()`) before *every*
 * captured action. So on gov.uk, whose hero image sits under a centred pointer, the magnifier took the
 * foreground and the capture read `"Image Magnify, document"` instead of the page — three retries, then
 * a refusal to report. The feature itself is now disabled by launch flag too (`SUPPRESSED_FEATURES` in
 * capture-core), but a flag only covers the affordance we happened to find. Parking the pointer covers
 * the class: hover-opened menus, tooltips, video controls, link previews.
 *
 * ## Why (0,0)
 *
 * Deterministic, and off the page on every window layout: captures run `--app`, which has a title bar
 * and no tab strip, so the top-left pixel is browser chrome when the window is maximized and bare
 * desktop when it is not. Windows has no hover hot corners, and the taskbar is at the other end of the
 * screen — a corner near it risks the Start button or the notification area.
 *
 * ## Why PowerShell
 *
 * Node cannot call `SetCursorPos` without a native addon. This is the same shape guidepup already uses
 * for `windowsActivate` (cscript → PowerShell → user32), so it introduces no new dependency.
 * `System.Windows.Forms` is loaded rather than `Add-Type -MemberDefinition`, because the latter compiles
 * C# at runtime and costs seconds where an assembly load costs milliseconds.
 *
 * A synthetic Chrome DevTools Protocol `Input.dispatchMouseEvent` would NOT do: it moves the renderer's
 * idea of the pointer but not the OS cursor, so Edge's own Ctrl-twice handler still sees an image under
 * the real one — and the renderer re-derives hover from the real position on the next scroll, which
 * quick-nav does constantly.
 */
import { execFile } from "node:child_process";

/** Top-left of the primary display. See the header for why this point and not a corner near the taskbar. */
const PARK_AT = { x: 0, y: 0 };

/**
 * A park that hangs must never hold up a capture. The pointer is a hazard to remove, not a
 * precondition to satisfy, so this budget is short and expiry is recorded rather than thrown.
 */
const PARK_TIMEOUT_MS = 5_000;

/**
 * Where to put the pointer, honouring the test lever.
 *
 * `A11Y_POINTER_AT="x,y"` exists to aim the pointer deliberately AT an image, which is how the Magnify
 * fault is reproduced on demand. This project's own rule: a guard that has not been shown to fail is not
 * a verified guard, and a canary that cannot express the fault is worthless. An unparseable value falls
 * back to the safe point rather than failing the capture — the resulting mark reports the coordinates
 * actually used, so a typo shows up as (0,0) rather than as silence.
 */
function requestedParkPoint() {
  const override = process.env.A11Y_POINTER_AT;
  if (!override) return PARK_AT;
  // Matched strictly rather than parsed with `Number.parseInt`, which is lenient enough to read
  // "640px,420" as (640,420) and "6 4 0,4 2 0" as (6,4). A coordinate that is nearly right is worse
  // than one that is refused: it parks the pointer somewhere nobody intended and reports success.
  // Negative values are allowed — a second display can legitimately sit left of or above the primary.
  const match = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(override);
  if (!match) return PARK_AT;
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** Exported for `pointer.test.ts`: the shell-out cannot run on a Mac, but this decision can. */
export const parkPointForTest = requestedParkPoint;

function setCursorPosition(x, y) {
  const script = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
    + `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: PARK_TIMEOUT_MS, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        return reject(new Error(stderr?.trim() || error.message, { cause: error }));
      },
    );
  });
}

/**
 * Move the pointer out of the page's way, recording the cost and any failure.
 *
 * Never throws. A guest that cannot move its own pointer still produces a capture — one carrying
 * whatever hover state it happened to have, which is exactly what every capture carried before this
 * existed. Turning that into a failed capture would trade a quiet risk for a loud outage.
 */
export async function parkPointer(diag) {
  const { x, y } = requestedParkPoint();
  const startedAt = Date.now();
  try {
    await setCursorPosition(x, y);
    diag?.mark("pointerParked", { x, y, ms: Date.now() - startedAt });
  } catch (error) {
    diag?.mark("pointerParkFailed", { x, y, error: error.message, ms: Date.now() - startedAt });
  }
}
