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
    // A THREE-FIELD line predates the owner and yields "", which must stay distinguishable from the
    // literal "unknown" a live worker reports when the process died before its pid could be resolved.
    // "nobody asked" and "we asked and could not tell" are different answers; conflating them is this
    // repo's most-recorded defect.
    owner: "",
  }]);
});

test("the owner is parsed, so 'we opened it' and 'the image came with it' are different answers", () => {
  // The specimen that made this necessary, from a GitHub windows-2022 runner on 2026-09-01.
  // `action-smoke` failed with this dialog blocking the desktop; the readiness guard correctly refused
  // to capture, and the report named the dialog but not its owner — so answering "did WE open it?" meant
  // grepping our own provisioning and inferring from its absence. Those need opposite work: ours is a bug
  // to fix, the runner image's is a machine to configure.
  const line = `197350${TAB}Performance Options${TAB}Advanced Processor scheduling OK Cancel${TAB}SystemPropertiesPerformance`;
  assert.deepEqual(parseDialogList(line), [{
    handle: "197350",
    title: "Performance Options",
    message: "Advanced Processor scheduling OK Cancel",
    owner: "SystemPropertiesPerformance",
  }]);
});

test("a dead process reports `unknown`, which is not the same as an old worker's empty owner", () => {
  const dead = parseDialogList(`5${TAB}Error${TAB}boom${TAB}unknown`)[0];
  const old = parseDialogList(`5${TAB}Error${TAB}boom`)[0];
  assert.equal(dead.owner, "unknown", "the window outlived its process — we asked and could not tell");
  assert.equal(old.owner, "", "a worker too old to report an owner — nobody asked");
  assert.notEqual(dead.owner, old.owner, "and the two must never collapse into one value");
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
