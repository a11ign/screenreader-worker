/**
 * The activation parser — the part that decides whether a capture trusts the cheap focus path.
 *
 * A misparse here is expensive in both directions. Read as "focused" when it was not, the capture reads an
 * unfocused browser and produces evidence about whatever window Windows had in front. Read as "no window" when
 * there is one, every capture pays for guidepup's fallback — the WMI-and-`Get-Process` path that took 342
 * seconds on a real website and is the whole reason this module exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseActivation } from "./window-focus.mjs";

const TAB = "\t";

test("a window that took the foreground is found and foreground", () => {
  const parsed = parseActivation(`133742${TAB}FOREGROUND${TAB}Example Domain`);
  assert.deepEqual(parsed, { found: true, foreground: true, title: "Example Domain", handle: "133742" });
});

test("REFUSED is found but NOT foreground — a different fault with a different repair", () => {
  // Windows only grants the foreground to a process that already has it or is handling input, which is why
  // ForegroundLockTimeout is 0 on these guests. A refusal must not be reported as success, and must not be
  // reported as "no window" either: relaunching Edge cannot fix a foreground-policy refusal.
  const parsed = parseActivation(`133742${TAB}REFUSED${TAB}Example Domain`);
  assert.equal(parsed.found, true);
  assert.equal(parsed.foreground, false);
});

test("NONE means no Chromium window exists — the one case guidepup's launcher is for", () => {
  assert.deepEqual(parseActivation("NONE"),
    { found: false, foreground: false, title: "", handle: "" });
});

test("empty output is not a window", () => {
  assert.equal(parseActivation("").found, false);
  assert.equal(parseActivation("\r\n").found, false);
  assert.equal(parseActivation(undefined as unknown as string).found, false);
});

test("an --app window has an empty title and is still a window", () => {
  // Captures run with --app, which has no browser chrome and therefore no "Edge" in the title — the exact
  // case guidepup's title matching handles badly, and the reason this path matches on window CLASS.
  const parsed = parseActivation(`999${TAB}FOREGROUND${TAB}`);
  assert.equal(parsed.found, true);
  assert.equal(parsed.foreground, true);
  assert.equal(parsed.title, "");
});

test("PowerShell noise is never a focused window", () => {
  // Guarding the guard: if the script errors, its complaint lands on the same stream. Reading that as a
  // focused window would skip the fallback and capture an unfocused browser — evidence from the wrong window,
  // which is the most damaging failure this tool has.
  assert.equal(parseActivation("Exception calling \"EnumWindows\" with \"2\" argument(s)").found, false);
  assert.equal(parseActivation(`0xFF${TAB}FOREGROUND${TAB}hex is not what is printed`).found, false);
  assert.equal(parseActivation("At line:12 char:3").found, false);
});
