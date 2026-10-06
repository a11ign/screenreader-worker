// @ts-check
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
import { errorText } from "./error-text.mjs";

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

/** @param {number} x @param {number} y @returns {Promise<void>} */
function setCursorPosition(x, y) {
  const script = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
    + `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`;
  // Typed at the binding rather than inline: `new Promise(...)` with a zero-argument `resolve()` needs a
  // hint (TS2810), and an inline cast on the executor needs a second closing paren that is easy to
  // lose — which is exactly what happened on the first attempt.
  /** @type {Promise<void>} */
  const moved = new Promise((resolve, reject) => {
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
  return moved;
}

/**
 * Two attempts, never more.
 *
 * THIS COMMENT USED TO SAY "the observed failures are transient spawn failures" AND THAT IS REFUTED --
 * see `wasKilledByTimeout`, which reads the `ms` these marks have always carried: all 11 on disk are
 * timeouts, not fast failures. The retry survives the refutation on a different argument (`Add-Type`
 * compiles C# on first use, so a cold attempt can be slow where a warm one is not); a third would be a
 * poll disguised as a remedy either way.
 */
const PARK_ATTEMPTS = 2;

/**
 * Move the pointer out of the page's way, recording the cost and any failure.
 *
 * Never throws. A guest that cannot move its own pointer still produces a capture — one carrying
 * whatever hover state it happened to have, which is exactly what every capture carried before this
 * existed. Turning that into a failed capture would trade a quiet risk for a loud outage.
 */
/**
 * RETRIED ONCE, because a failure here silently splits a good/bad PAIR.
 *
 * Measured 2026-09-01 over 4,926 captures: 12 failed to park (0.2%) and NINE of them split their pair --
 * the failing half was measured with a different instrument from its mate. That is the U+FFFC defect,
 * which this project calls the one it cannot tolerate, and it had been invisible because the failure was
 * marked and never read.
 *
 * Four of the splits are `image-*` against a 13.9% base rate. That is where the remedy matters most: the
 * magnifier needs an image under the cursor to appear at all, so the failures concentrate on exactly the
 * pages the park exists for.
 *
 * ONE retry, not a loop. Every observed failure is `Command failed: powershell ...` -- a transient failure
 * to spawn, not a guest that cannot move its pointer -- so a second attempt is worth its cost and a third
 * would be a poll disguised as a remedy. `attempts` is recorded on the SUCCESS mark too, so "parked first
 * time" and "parked on the retry" are different observations rather than the same silence.
 *
 * Still never throws. A guest that cannot move its own pointer after two tries still produces a capture --
 * carrying whatever hover state it happened to have, which is what every capture carried before this
 * existed. Turning that into a failed capture would trade a quiet risk for a loud outage, and the audit
 * now names the pairs it split.
 *
 * `setCursor` is injected so the RETRY can be tested off Windows. The real one shells out to PowerShell
 * and only runs on a guest, which is why this file's own header says the decision is all that can be
 * tested here -- and a retry is a decision. Same seam as `file-version-memo.test.ts`, for the same reason:
 * a remedy must be shown to fail before it is trusted, and this one cannot be on a Mac otherwise.
 *
 * @param {{mark: (event: string, detail: object) => void} | undefined} [diag]
 * @param {{setCursor?: (x: number, y: number) => Promise<void>}} [deps]
 */
export async function parkPointer(diag, { setCursor = setCursorPosition } = {}) {
  const { x, y } = requestedParkPoint();
  const startedAt = Date.now();
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= PARK_ATTEMPTS; attempt += 1) {
    try {
      await setCursor(x, y);
      diag?.mark("pointerParked", { x, y, attempts: attempt, ms: Date.now() - startedAt });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  diag?.mark("pointerParkFailed", {
    x, y, attempts: PARK_ATTEMPTS, error: errorText(lastError), ms: Date.now() - startedAt,
    // WHICH FAILURE THIS WAS, stated rather than inferred from `ms`. See `wasKilledByTimeout`.
    timedOut: wasKilledByTimeout(lastError),
  });
}

/**
 * Was this failure the TIMEOUT firing, or PowerShell answering fast and badly?
 *
 * THE TWO ARE INDISTINGUISHABLE BY ERROR TEXT and this file asserted the wrong one for weeks. The comment
 * above `PARK_ATTEMPTS` reads *"the observed failures are transient spawn failures"* and the retry was
 * built on it. Read off the 11 `pointerParkFailed` marks on disk 2026-09-05, using the `ms` the same mark
 * already carried and nobody had looked at: every one reads between **5,032 and 9,134 ms** against a
 * `PARK_TIMEOUT_MS` of 5,000, and none carries an `attempts` field — so all 11 predate the retry and each
 * is ONE attempt that hit the ceiling. A transient spawn failure returns in tens to low hundreds of
 * milliseconds. **These are timeouts, and the premise the retry rests on is refuted by its own mark.**
 *
 * `execFile` kills the child on timeout, so Node's error carries `killed: true` with `signal: "SIGTERM"`
 * while the MESSAGE is the reconstructed command line either way -- the child is killed before it prints
 * anything, so a timeout and a silent non-zero exit produce identical text. `setCursorPosition` attaches
 * that error as `cause`, so the discriminator was already reachable and simply never recorded.
 *
 * THE RETRY IS KEPT DESPITE THE REFUTATION, deliberately. `Add-Type` compiles C# on first use, so a cold
 * attempt genuinely can be slow where a warm one is not, and a second attempt is worth its 5 s on that
 * reading. What is NOT justified any more is the claim about WHY, and raising `PARK_TIMEOUT_MS` is not
 * done here because nothing measures how long PowerShell actually needed -- only that it exceeded 5 s.
 * `timedOut` is what makes the next occurrence answer that instead of inviting another guess.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function wasKilledByTimeout(error) {
  const cause = /** @type {{ cause?: unknown }} */ (error)?.cause;
  // BOTH FIELDS, not just `killed`. A child killed by anything else -- a guest shutting down, an operator
  // ending the task -- is also `killed: true`, and calling that a timeout would put a real outage in the
  // bucket labelled "this is fine".
  const killed = /** @type {{ killed?: unknown, signal?: unknown }} */ (cause);
  return killed?.killed === true && typeof killed?.signal === "string";
}
