/**
 * The wrong-window gate, against the diagnostics that reached it (a11ign#5697, row #5699).
 *
 * Fixtures are the diagnostics shapes from `smoke-w12.json` (26200) and `smoke-w6.json` (22631), as quoted in
 * `.acceptance/agent~captures-on-windows-26200-5697.md`. Each control pins one way the gate must NOT fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDiagnostics, failIfCaptureIsOnWrongWindow } from "./capture-pure.ts";
import { FAULT, faultCode } from "./capture-faults.ts";

const PAGE_TITLE = "Example Domain";
// A real page title as NVDA speaks it carries the browser's suffix (known-gaps.md §44).
const EDGE_SUFFIX = " - Profile 1 - Microsoft Edge";
const PAGE_LINES = Array.from({ length: 14 }, (_, i) => `line ${i}`);

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

// A window whose title is not a shell's: NVDA was on a settings window and read it as two identical phrases.
// No shell signature matches it, so only the comparison with the page's own title can tell it apart.
function otherWindowCapture() {
  const diag = createDiagnostics();
  diag.mark("documentReady", { ok: true, title: "Settings", attempt: 1 });
  diag.mark("afterStart", { lastSpoken: "Settings" });
  return { diag, transcript: ["Settings", "Settings"] };
}

function pageCapture(pageTitle: string, transcript: string[]) {
  const diag = createDiagnostics();
  diag.mark("documentReady", { ok: true, title: pageTitle + EDGE_SUFFIX, attempt: 1 });
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

test("the 26200 console, read as two identical phrases, is a wrong-window fault, not a success", () => {
  const { diag, transcript } = consoleCapture();
  const code = thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, PAGE_TITLE));
  assert.equal(code, FAULT.SCREEN_READER_MUTE);
});

test("the 22631 taskbar, read as one phrase, is a wrong-window fault even when NVDA was silent", () => {
  const { diag, transcript } = taskbarCapture();
  const code = thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, PAGE_TITLE));
  assert.equal(code, FAULT.SCREEN_READER_MUTE);
});

test("a window with a non-shell title, read as two identical phrases, is a wrong-window fault", () => {
  const { diag, transcript } = otherWindowCapture();
  const code = thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, PAGE_TITLE));
  assert.equal(code, FAULT.SCREEN_READER_MUTE);
});

test("with no page title to compare, the console is still a wrong-window fault by its shell signature", () => {
  const { diag, transcript } = consoleCapture();
  const code = thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, null));
  assert.equal(code, FAULT.SCREEN_READER_MUTE);
});

test("with no page title to compare, a non-shell title is not tripped: that case needs the page title", () => {
  const { diag, transcript } = otherWindowCapture();
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, null)), null);
});

test("control: the page's own title in NVDA's title, with a real transcript, raises nothing", () => {
  const { diag, transcript } = pageCapture(PAGE_TITLE, PAGE_LINES);
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, PAGE_TITLE)), null);
});

test("control: a page whose own title names a shell window is not tripped by the title alone", () => {
  const { diag, transcript } = pageCapture("Taskbar setup guide", PAGE_LINES);
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, "Taskbar setup guide")), null);
});

test("control: a page titled like a console with more than two distinct phrases raises nothing", () => {
  const { diag, transcript } = pageCapture("cmd.exe reference", ["cmd.exe reference", "Options", "Syntax"]);
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, "cmd.exe reference")), null);
});

test("control: the page's own title in NVDA's title raises nothing, even when it reads as two identical phrases", () => {
  const { diag, transcript } = pageCapture(PAGE_TITLE, ["heading, level 1, Example Domain", "heading, level 1, Example Domain"]);
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, PAGE_TITLE)), null);
});

test("control: the last documentReady read decides, so a retry that reached the page is not tripped", () => {
  const { diag } = consoleCapture();
  diag.mark("documentReady", { ok: true, title: PAGE_TITLE + EDGE_SUFFIX, attempt: 2 });
  const transcript = ["heading, level 1, Example Domain"];
  assert.equal(thrownFaultCode(() => failIfCaptureIsOnWrongWindow(transcript, diag, PAGE_TITLE)), null);
});
