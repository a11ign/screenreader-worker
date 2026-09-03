// EDITING THE FILE THAT DECIDES WHETHER NVDA STARTS AT ALL.
//
// `withIniSetting` is pure for exactly that reason: a malformed edit is a dead worker, and a dead worker
// on the fleet reads as a broken guest rather than as a bad config write. Every state an NVDA ini can be
// in is covered here, because the applier runs at boot on every guest.
//
// The SETTING it exists for is a product decision taken 2026-09-03, and the test is written against the
// decision rather than the current value: `reportLanguage` is on because at NVDA's default a WCAG 3.1.2
// failure is announced as a change of VOICE and no text at all, so a pipeline that captures speech as
// text is structurally blind to it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { withIniSetting, withLogLevel, CAPTURE_SETTINGS } from "./nvda-logging.mjs";

test("adds the key when the section exists without it", () => {
  const out = withIniSetting("[documentFormatting]\n\treportTables = True\n", "documentFormatting", "reportLanguage", "True");
  assert.match(out ?? "", /\[documentFormatting\]\n\treportLanguage = True/);
  // The existing key must survive — this writes one setting, it does not rewrite the section.
  assert.match(out ?? "", /reportTables = True/);
});

test("adds the section when it does not exist", () => {
  const out = withIniSetting("[general]\n\tlogLevel = INFO\n", "documentFormatting", "reportLanguage", "True");
  assert.match(out ?? "", /\[documentFormatting\]\n\treportLanguage = True/);
  assert.match(out ?? "", /\[general\]/, "the rest of the file must survive");
});

test("replaces an existing value rather than adding a second line", () => {
  const out = withIniSetting("[documentFormatting]\n\treportLanguage = False\n", "documentFormatting", "reportLanguage", "True");
  assert.match(out ?? "", /reportLanguage = True/);
  assert.doesNotMatch(out ?? "", /reportLanguage = False/,
    "two values for one key is a config NVDA may read either way");
});

test("THE SAME KEY IN ANOTHER SECTION IS A DIFFERENT SETTING", () => {
  // The bug this file exists to prevent recurring, and it shipped twice before being caught.
  //
  // The first patcher searched for `key = ...` ANYWHERE in the file. On a guest already carrying
  // `[documentFormatting] reportLanguage = True` from an earlier mistake, asking for
  // `[speech] reportLanguage = True` found the wrong one, rewrote it in place, and reported success —
  // so the setting stayed inert while every check said it was applied.
  //
  // A key name means nothing without its section: `reportLanguage` is a real setting in `[speech]` and a
  // dead letter anywhere else.
  const stale = "[documentFormatting]\n\treportLanguage = True\n[speech]\n\tsynth = oneCore\n";
  const out = withIniSetting(stale, "speech", "reportLanguage", "True") ?? "";
  assert.match(out, /\[speech\]\n\treportLanguage = True/,
    "it must write into [speech], which is where NVDA reads it");
  assert.match(out, /\[documentFormatting\]\n\treportLanguage = True/,
    "and leave the other section alone rather than moving its key");
  assert.match(out, /synth = oneCore/, "the section's existing keys must survive");
});

test("adds the section at the END when it is missing, without disturbing what is there", () => {
  const out = withIniSetting("[general]\n\tlogLevel = INFO\n", "speech", "reportLanguage", "True") ?? "";
  assert.match(out, /\[speech\]\n\treportLanguage = True/);
  assert.match(out, /\[general\]\n\tlogLevel = INFO/, "the existing section must be untouched");
});

test("returns null when it already says that — the applier must be idempotent", () => {
  // A boot that rewrites the file every time is a boot that can corrupt it every time, and this runs on
  // every guest at every start.
  assert.equal(withIniSetting("[documentFormatting]\n\treportLanguage = True\n", "documentFormatting", "reportLanguage", "True"), null);
});

test("the log level still works, so generalising did not break its caller", () => {
  // `withLogLevel` became a wrapper when a second setting needed writing. It has a live call site and its
  // own vocabulary check, which the generalisation must not have dropped.
  assert.match(withLogLevel("[general]\n\tlogLevel = INFO\n", "DEBUG") ?? "", /logLevel = DEBUG/);
  assert.equal(withLogLevel("[general]\n", "LOUDER"), null, "an invalid level must still be refused");
});

test("reportLanguage is on, and NVDA's spelling is used verbatim", () => {
  const language = CAPTURE_SETTINGS.find((s) => s.key === "reportLanguage");
  assert.ok(language, "3.1.2 is unobservable without it — see the module header for the decision");
  // `[speech]`, and this assertion exists because the first version said `documentFormatting` — where
  // NVDA does NOT read it, so the setting was inert while `getSettings()` reported it as present. Read
  // from NVDA's own configSpec: `[speech] reportLanguage = boolean(default=false)`.
  assert.equal(language.section, "speech",
    "NVDA reads reportLanguage from [speech]; writing it elsewhere is a setting that looks applied and does nothing");
  // `True`, not `true`. NVDA's ini is Python's configobj and the value is written verbatim, so the
  // casing is the contract rather than a preference.
  assert.equal(language.value, "True");
  assert.ok((language.why ?? "").length > 20, "a setting that changes the evidence must say why it is on");
});
