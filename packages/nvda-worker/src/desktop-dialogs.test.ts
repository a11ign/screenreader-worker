/**
 * The dialog-list parser — the only part of `desktop-dialogs.mjs` a test can reach off Windows.
 *
 * It is also the part that matters most, because a FALSE positive here takes a healthy worker out of service:
 * `noBlockingDialog` gates readiness, so anything this misreads as a dialog stops the guest accepting work.
 * PowerShell writes warnings and progress records to the same stream as its output, so "a line came back"
 * must never mean "a dialog is up".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDialogList } from "./desktop-dialogs.mjs";

const TAB = "\t";

test("no output means no dialogs — an idle desktop is the normal case", () => {
  assert.deepEqual(parseDialogList(""), []);
  assert.deepEqual(parseDialogList("\r\n\r\n"), []);
  assert.deepEqual(parseDialogList(undefined as unknown as string), []);
});

test("the specimen this module exists for is parsed into title and message", () => {
  // Verbatim from the guest desktop, which is where this fault was finally seen.
  const line = `65990${TAB}Error${TAB}Couldn't terminate existing NVDA process, abandoning start: `
    + `Exception: [WinError 5] Access is denied. OK`;
  assert.deepEqual(parseDialogList(line), [{
    handle: "65990",
    title: "Error",
    message: "Couldn't terminate existing NVDA process, abandoning start: "
      + "Exception: [WinError 5] Access is denied. OK",
  }]);
});

test("several dialogs are all reported — one failure can leave more than one box up", () => {
  const out = [`111${TAB}Error${TAB}first`, `222${TAB}NVDA${TAB}second`].join("\n");
  assert.deepEqual(parseDialogList(out).map((d) => d.handle), ["111", "222"]);
});

test("PowerShell noise is NOT a dialog, because a false positive sidelines a healthy worker", () => {
  // `noBlockingDialog` gates readiness. A warning line misread as a dialog would report the desktop blocked
  // and stop the guest taking work — the same shape as the warm-up gate that once sidelined a healthy guest
  // for a whole session.
  const noise = [
    "WARNING: Add-Type used a deprecated flag",
    "Exception calling \"EnumWindows\" with \"2\" argument(s)",
    "",
    "   at <ScriptBlock>, <No file>: line 12",
  ].join("\n");
  assert.deepEqual(parseDialogList(noise), []);
});

test("a dialog with no message still counts — the title alone blocks input just as well", () => {
  const parsed = parseDialogList(`999${TAB}Error${TAB}`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].message, "");
  assert.equal(parsed[0].title, "Error");
});

test("a handle must be a positive integer, not merely present", () => {
  // Guarding the guard: if the separator ever changes, every line becomes one field and the handle stops
  // looking like a number. That must read as "no dialogs found", never as a dialog with a garbage handle —
  // the close path posts WM_CLOSE to whatever it is given.
  assert.deepEqual(parseDialogList("Error: something went wrong entirely"), []);
  assert.deepEqual(parseDialogList(`0x1234${TAB}Error${TAB}hex is not what PowerShell prints`), []);
});
