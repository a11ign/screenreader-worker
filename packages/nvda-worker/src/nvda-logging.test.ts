// Editing nvda.ini decides whether NVDA starts at all, so a malformed edit is a dead worker. These are
// the boundaries of the only function that writes to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withLogLevel, withIniSetting } from "./nvda-logging.mjs";

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

test("a config with no [general] section still gets a valid one, APPENDED", () => {
  // APPENDED, where this used to assert PREPENDED — a deliberate change, made when the patcher was
  // generalised to write any section and scoped to write inside it.
  //
  // Prepending a header puts it above everything, and any key at the top of the file that belonged to no
  // section would silently become part of the new one. That cannot happen in guidepup's config today, and
  // "cannot happen today" is how a config writer acquires a latent bug. Appending re-parents nothing.
  const updated = withLogLevel("[speech]\n\tsynth = oneCore\n", "DEBUG")!;
  assert.match(updated, /\[general\]\n\tlogLevel = DEBUG/);
  assert.match(updated, /^\[speech\]\n\tsynth = oneCore/, "what was there must stay where it was");
});

test("a value containing a regex metacharacter is not confused with a similar-looking wrong value", () => {
  // `withIniSetting` builds its "already set" check out of `section`, `key` and `value` by splicing them
  // into a `RegExp` constructor string. Every value written today (`"True"`, log levels) has nothing a
  // regex treats specially, but nothing stops a future setting from carrying one -- a numeric verbosity
  // level, say. Unescaped, `.` in "1.5" is a WILDCARD, so a file that actually holds the wrong value
  // "1X5" would ALSO match "already set to 1.5" and be left in place, silently wrong.
  const wrongValue = "[speech]\n\tsymbolLevel = 1X5\n";
  const updated = withIniSetting(wrongValue, "speech", "symbolLevel", "1.5");
  assert.notEqual(updated, null,
    "the file holds 1X5, not 1.5 -- it must be rewritten, not read as already correct");
  assert.match(updated!, /symbolLevel = 1\.5/);
});
