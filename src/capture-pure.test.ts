/**
 * The wrong-window gate, against the two real diagnostics that reached it (a11ign#5697).
 *
 * Fixtures are the diagnostics shapes from `smoke-w12.json` (26200) and `smoke-w6.json` (22631), as quoted in
 * `.acceptance/agent~captures-on-windows-26200-5697.md`. Each control pins one way the gate must NOT fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDiagnostics, failIfCaptureIsOnWrongWindow } from "./capture-pure.ts";
import { FAULT, faultCode } from "./capture-faults.ts";

// The 26200 capture: the launcher's `cmd.exe` held the foreground, NVDA spoke its window as "blank", and
// the read-through heard two identical phrases. `lastSpoken` is non-empty, so the mute check does not fire.
function consoleCapture() {
  const diag = createDiagnostics();
  diag.mark("documentReady", { ok: true, title: "C: WINDOWS SYSTEM 32 cmd dot exe", attempt: 1 });
  diag.mark("afterStart", { lastSpoken: "blank" });
  return { diag, transcript: ["blank", "blank"] };
}

// The 22631 capture's first pass: the taskbar held the foreground and NVDA was silent, one phrase came back.
function taskbarCapture() {
  const diag = createDiagnostics();
  diag.mark("documentReady", { ok: true, title: "Taskbar", attempt: 1 });
  diag.mark("afterStart", { lastSpoken: "" });
  return { diag, transcript: ["Taskbar"] };
}

function pageCapture(title: string, transcript: string[]) {
  const diag = createDiagnostics();
  diag.mark("documentReady", { ok: true, title, attempt: 1 });
  diag.mark("afterStart", { lastSpoken: transcript[0] ?? "" });
  return { diag, transcript };
}

function thrownFaultCode(run: () => void) {
  try {
    run();
  } catch (error) {
    return faultCode(error);
  }
  return null;
}

test("a console window read as two identical phrases is a wrong-window fault, not a success", () => {
  const { diag, transcript } = consoleCapture();
  const code = thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag));
  assert.equal(code, FAULT.SCREEN_READER_MUTE);
});

test("a taskbar read as one phrase is a wrong-window fault even when NVDA was silent", () => {
  const { diag, transcript } = taskbarCapture();
  const code = thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag));
  assert.equal(code, FAULT.SCREEN_READER_MUTE);
});

test("control: a real page title with a real transcript raises nothing", () => {
  const { diag, transcript } = pageCapture("Example Domain", Array.from({ length: 14 }, (_, i) => `line ${i}`));
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag)), null);
});

test("control: a page whose own title names a shell window is not tripped by the title alone", () => {
  const { diag, transcript } = pageCapture("Taskbar setup guide", Array.from({ length: 14 }, (_, i) => `line ${i}`));
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag)), null);
});

test("control: a page titled like a console with more than two distinct phrases raises nothing", () => {
  const { diag, transcript } = pageCapture("cmd.exe reference", ["cmd.exe reference", "Options", "Syntax"]);
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag)), null);
});

test("control: the last documentReady read decides, so a retry that reached the page is not tripped", () => {
  const { diag } = consoleCapture();
  diag.mark("documentReady", { ok: true, title: "Example Domain", attempt: 2 });
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(["heading, level 1, Example Domain"], diag)), null);
});
