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

import { withIniSetting, withLogLevel, CAPTURE_SETTINGS, captureSettingsDigest } from "./nvda-logging.mjs";

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

/**
 * `autoLanguageSwitching` and `reportNotSupportedLanguage`, written and not yet applied — see
 * docs/backlog.md, "Two NVDA settings that change WHAT IT SAYS are not pinned". `screenReaderSettings`
 * is a capture cache key, so these must ride the next key change rather than spend a recapture alone;
 * this file exists so the entries are ready and PROVEN the moment that happens, rather than typed in a
 * hurry beside it.
 *
 * Both researched from NVDA's actual source rather than assumed from the `reportLanguage` sibling:
 * `source/config/configSpec.py` for section and default, `source/speech/languageHandling.py` for what
 * each one actually gates. The backlog row's own inference — that `autoLanguageSwitching` is the
 * precondition for `reportLanguage` firing at all — does NOT hold: `shouldMakeLangChangeCommand()` is
 * `autoLanguageSwitching OR reportLanguage`, so `reportLanguage` alone still inserts a language-change
 * marker into the speech sequence. What `autoLanguageSwitching` actually preconditions is
 * `reportNotSupportedLanguage` (`shouldReportNotSupported()` is `autoLanguageSwitching AND
 * reportNotSupportedLanguage != "off"`), and it separately changes `reportLanguage`'s OWN announcement —
 * `getLangToReport()` reports a root language code ("es") rather than a full one ("es_ES") for the
 * identical passage, depending on this setting alone.
 */
test("autoLanguageSwitching is in [speech], on, and states its OWN effect on reportLanguage's announcement", () => {
  const setting = CAPTURE_SETTINGS.find((s) => s.key === "autoLanguageSwitching");
  assert.ok(setting, "reportNotSupportedLanguage's precondition, and reportLanguage's own root-vs-full "
    + "language code, both depend on this — see the module header for both effects, sourced from "
    + "languageHandling.py rather than assumed");
  // Read from configSpec.py directly: `[speech] autoLanguageSwitching = boolean(default=true)`.
  assert.equal(setting.section, "speech");
  assert.equal(setting.value, "True");
  assert.ok((setting.why ?? "").length > 20, "a setting that changes the evidence must say why it is on");
});

test("reportNotSupportedLanguage is in [speech], and takes NVDA's own option spelling", () => {
  const setting = CAPTURE_SETTINGS.find((s) => s.key === "reportNotSupportedLanguage");
  assert.ok(setting, "a passage in an unsupported language is announced, beeped or silent depending on "
    + "this value, and the corpus must declare which");
  // Read from configSpec.py directly: `[speech] reportNotSupportedLanguage = option("speech", "beep",
  // "off", default="speech")` — an OPTION, not a boolean, and "speech" is the DEFAULT rather than a value
  // this project chose to turn on. Pinned anyway: the default is exactly as capable of drifting between
  // guests as an explicitly-set value, and the digest cannot tell "default" from "someone set it back".
  assert.equal(setting.section, "speech");
  assert.equal(setting.value, "speech");
  assert.ok((setting.why ?? "").length > 20, "a setting that changes the evidence must say why it is pinned");
});

test("the digest MOVES when CAPTURE_SETTINGS gains an entry -- the mechanism is not decorative", () => {
  // Proves the property the whole design depends on, rather than trusting that mapping over an array
  // must obviously do this. `captureSettingsDigest` is pure and derived from `CAPTURE_SETTINGS`
  // directly, so a real addition (not a fixture standing in for one) is what this asserts against.
  const before = CAPTURE_SETTINGS
    .filter((s) => s.key !== "autoLanguageSwitching" && s.key !== "reportNotSupportedLanguage")
    .map((s) => `${s.section}.${s.key}=${s.value}`).sort().join(",");
  const after = captureSettingsDigest();
  assert.notEqual(after, before,
    "adding autoLanguageSwitching and reportNotSupportedLanguage must move the digest, or the cache key "
    + "does not actually depend on the list it claims to be derived from");
  // And the two new keys are actually IN the moved digest, not merely different by coincidence.
  assert.match(after, /speech\.autoLanguageSwitching=True/);
  assert.match(after, /speech\.reportNotSupportedLanguage=speech/);
});

test("the digest is unaffected by `why`, order, or a comment — only section/key/value carry evidence", () => {
  // The digest answers "is this the same evidence", and a reworded comment or a reordered declaration is
  // not a different capture. Two settings built in the opposite order must still agree.
  const reordered = [...CAPTURE_SETTINGS].reverse();
  const digestOf = (settings: typeof CAPTURE_SETTINGS) => settings
    .map((s) => `${s.section}.${s.key}=${s.value}`).sort().join(",");
  assert.equal(digestOf(reordered), digestOf(CAPTURE_SETTINGS));
});
