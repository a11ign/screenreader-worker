// Editing nvda.ini decides whether NVDA starts at all, so a malformed edit is a dead worker. These are
// the boundaries of the only function that writes to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withLogLevel } from "./nvda-logging.mjs";

const INI = "[general]\n\tlanguage = Windows\n\tshowSpeechViewerAtStartup = False\n\n[speech]\n\tsynth = oneCore\n";

test("an existing logLevel is replaced, not duplicated", () => {
  const updated = withLogLevel("[general]\n\tlogLevel = INFO\n", "DEBUG")!;
  assert.match(updated, /logLevel = DEBUG/);
  assert.equal(updated.match(/logLevel/g)!.length, 1);
});

test("a missing logLevel is added under [general], leaving the rest intact", () => {
  const updated = withLogLevel(INI, "DEBUG")!;
  assert.match(updated, /\[general\]\n\tlogLevel = DEBUG/);
  assert.match(updated, /synth = oneCore/, "other settings must survive");
  assert.match(updated, /showSpeechViewerAtStartup = False/, "the Speech Viewer fix must survive");
});

test("a config already at the requested level is left untouched", () => {
  // Returning null means "no write", which keeps a boot from rewriting the file every time.
  assert.equal(withLogLevel("[general]\n\tlogLevel = DEBUG\n", "DEBUG"), null);
});

test("an unrecognised level is refused rather than written into the config", () => {
  // A bad value here can stop NVDA starting; guessing is not an option.
  assert.equal(withLogLevel(INI, "VERBOSE"), null);
  assert.equal(withLogLevel(INI, ""), null);
});

test("a config with no [general] section still gets a valid one", () => {
  const updated = withLogLevel("[speech]\n\tsynth = oneCore\n", "DEBUG")!;
  assert.match(updated, /^\[general\]\n\tlogLevel = DEBUG/);
  assert.match(updated, /synth = oneCore/);
});
