// @ts-check
/**
 * Turn NVDA's own logging up, on demand, so a mute screen reader can be explained.
 *
 * The fault this exists for: NVDA goes mute on one guest and not its clones, and NVDA's log says
 * nothing about it. At the default level the whole session log is **seven lines**, ending at
 * "Loading config", with zero errors — identical on a healthy guest and a failing one. There is
 * simply no evidence in it, which is why "reinstall NVDA" was a guess rather than a diagnosis.
 *
 * `nvda.ini` lives under the worker's own `%LOCALAPPDATA%`, so unlike the Edge policy this needs no
 * elevation — the worker can do it itself.
 *
 * **Opt-in, via `A11Y_NVDA_LOG_LEVEL`.** Debug logging is not free: NVDA writes a great deal at that
 * level, and this pipeline is sensitive enough to per-capture timing that turning it on by default
 * would change the thing being measured. Set it when diagnosing, unset it afterwards.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** NVDA's own vocabulary. Anything else is refused rather than written blindly into a config file. */
const LEVELS = new Set(["DEBUG", "INFO", "WARNING", "ERROR", "OFF", "DEBUGWARNING"]);

/**
 * A literal, safe to splice into a `RegExp` constructor string.
 *
 * `withIniSetting` builds patterns out of `section`, `key` and `value`, and every caller today passes
 * plain words ("general", "reportLanguage", "True") with nothing a regex would treat specially. Nothing
 * stops a FUTURE `CAPTURE_SETTINGS` entry from carrying a value that does -- a decimal verbosity level's
 * `.` matches any character, and a value containing `(` throws outright, both caught by `applyOne`'s
 * `catch` and logged as a failed write rather than left silently unset. Escaping now costs nothing against
 * today's values and closes that off before a setting needs it.
 */
const escapeRegExp = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A literal, safe to splice into `String.replace`'s REPLACEMENT argument.
 *
 * The other half of the same defect, on the other side of the same call: `escapeRegExp` above protects the
 * PATTERN, and the replacement string has its own special syntax -- `$&`, `` $` ``, `$'`, `$1` all expand
 * inside it, which a pattern-only escape does nothing about. Reproduced: `withIniSetting(body, "speech",
 * "rate", "a$&b")` wrote the whole matched line into the middle of the value instead of the literal
 * requested, because `$&` in a replacement string means "the match", not the two characters dollar and
 * ampersand. `$$` is how `String.replace` spells a literal `$`, so escaping here is DIFFERENT from
 * `escapeRegExp` and must not be confused with it.
 */
const escapeReplacement = (/** @type {string} */ text) => text.replace(/\$/g, "$$$$");

/**
 * The `nvda.ini` body with `logLevel` set, or null when nothing needs changing.
 *
 * Pure, because the risky part is editing a config file that decides whether NVDA starts at all, and a
 * malformed edit is a dead worker. Handles both "the key exists" and "there is no [general] section".
 *
 * @param {string} body current file contents
 * @param {string} level one of LEVELS
 * @returns {string | null}
 */
export function withLogLevel(body, level) {
  return LEVELS.has(level) ? withIniSetting(body, "general", "logLevel", level) : null;
}

/**
 * Set one key in one section of an NVDA ini, or return null when it already says that.
 *
 * Extracted from `withLogLevel` when a SECOND setting needed writing, and generalised rather than copied:
 * editing the file that decides whether NVDA starts at all is the risky part, and two hand-written
 * versions of that edit is this repo's most-repeated defect aimed at a config parser.
 *
 * Handles the three states a section-based ini can be in — the key exists, the section exists without the
 * key, and neither exists. Returning `null` for "already correct" is what keeps the caller idempotent: a
 * boot that rewrites the file every time is a boot that can corrupt it every time.
 *
 * @param {string} body current file contents
 * @param {string} section without brackets, e.g. "general"
 * @param {string} key e.g. "reportLanguage"
 * @param {string} value written verbatim, so the caller owns NVDA's spelling ("True", not "true")
 * @returns {string | null}
 */
export function withIniSetting(body, section, key, value) {
  // SCOPED TO THE SECTION, and the first version was not — which shipped an inert setting twice over.
  //
  // It searched for `key = ...` anywhere in the file. On a guest that already carried
  // `[documentFormatting] reportLanguage = True` from an earlier mistake, asking for
  // `[speech] reportLanguage = True` FOUND THE WRONG ONE, rewrote it in place, and reported success. The
  // ini is section-based and a key name means nothing without its section: `reportLanguage` is a real
  // setting in `[speech]` and a dead letter anywhere else, and NVDA carries several names that appear in
  // more than one section.
  const bounds = sectionBounds(body, section);
  if (!bounds) return `${body}${body.endsWith("\n") || body === "" ? "" : "\n"}[${section}]\n\t${key} = ${value}\n`;
  const [start, end] = bounds;
  const within = body.slice(start, end);
  if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*${escapeRegExp(value)}\\s*$`, "mi").test(within)) return null;
  const anyValue = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "mi");
  const updated = anyValue.test(within)
    ? within.replace(anyValue, `\t${escapeReplacement(key)} = ${escapeReplacement(value)}`)
    : within.replace(new RegExp(`^\\[${escapeRegExp(section)}\\]`, "mi"),
        `[${escapeReplacement(section)}]\n\t${escapeReplacement(key)} = ${escapeReplacement(value)}`);
  return body.slice(0, start) + updated + body.slice(end);
}

/**
 * Where one section's text starts and ends — the header line through to the next header, or the end.
 *
 * @param {string} body
 * @param {string} section
 * @returns {[number, number] | null}
 */
function sectionBounds(body, section) {
  const header = new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "mi");
  const found = header.exec(body);
  if (!found) return null;
  const next = /^\[[^\]]+\]\s*$/m.exec(body.slice(found.index + found[0].length));
  const end = next ? found.index + found[0].length + next.index : body.length;
  return [found.index, end];
}

/**
 * Apply `A11Y_NVDA_LOG_LEVEL` to every nvda.ini found. Returns the files changed.
 *
 * @param {string[]} configPaths from diagnostics.screenReaderState
 * @param {(line: string) => void} log
 */
export function applyRequestedLogLevel(configPaths, log) {
  const level = (process.env.A11Y_NVDA_LOG_LEVEL || "").toUpperCase();
  if (!level) return [];
  if (!LEVELS.has(level)) {
    log(`A11Y_NVDA_LOG_LEVEL=${level} is not an NVDA log level; ignoring it`);
    return [];
  }
  // THROUGH `applyOne`, which was extracted for the capture settings and does exactly this: read, patch,
  // write, and record the failure rather than swallow it. Two copies of "edit every nvda.ini safely" is
  // the shape this file already fixed once at the patcher level — `withLogLevel` became a wrapper around
  // `withIniSetting` — and leaving the loop duplicated would have kept half of it.
  //
  // `logLevel` lives under `[general]`, which is where `withLogLevel` has always put it.
  const changed = configPaths.flatMap((path) =>
    applyOne(path, { section: "general", key: "logLevel", value: level }, log));
  if (changed.length) log(`NVDA logLevel set to ${level} in ${changed.length} config(s); restart NVDA to apply`);
  return changed;
}

/**
 * Settings this project deliberately turns ON, because a default hides evidence a real user can see.
 *
 * **`reportLanguage` is here by a product decision taken 2026-09-03, and the reasoning is worth keeping
 * because it overturned a rule this repo had been applying too broadly.**
 *
 * WCAG 3.1.2 fails when a passage in another language carries no `lang`. At NVDA's defaults that failure
 * is announced by a CHANGE OF VOICE and no text at all — so a pipeline that captures speech as text is
 * structurally blind to it, and 3.1.2 was recorded as out of reach. With Report Language on, NVDA speaks
 * the language and it lands in the transcript like anything else.
 *
 * The rule that had blocked it — *"record settings; do not tune them, because NVDA's defaults are what a
 * real user experiences"* — is **wrong as stated**, and that is the decision. Screen reader users are
 * heavy configurers: speech rate, verbosity, punctuation and symbol level are all routinely moved far
 * from default, and a tool that only ever describes an unconfigured user is not describing a real one.
 * What matters is not whether a setting is default, but whether the evidence it produces is DECLARED and
 * cannot silently blend with evidence produced under a different setting.
 *
 * So the real rule, and the one this list is governed by: **a setting that changes what NVDA SAYS is a
 * cache-key input.** `screenReaderSettingsDigest` carries it into `environmentKey`, and
 * `fleet-consistency` treats it as MUST_MATCH, exactly as `browserVersion` and `guidepupVersion` are —
 * for the identical reason, which is that two guests disagreeing about it produce two kinds of evidence
 * that must never share a cache entry.
 *
 * **And turning it on is what makes it recordable.** Measured 2026-09-02: `getSettings()` returns only
 * sections NVDA has actually WRITTEN, so at defaults there is no `documentFormatting` section and "off"
 * is indistinguishable from "never asked" — you cannot record the setting without first setting it.
 * Writing it resolves that: the value becomes readable, so every capture can state what it was taken
 * under rather than assuming.
 *
 * NVDA's own spelling, verbatim — the ini takes `True`, not `true`.
 */
export const CAPTURE_SETTINGS = Object.freeze([
  // `[speech]`, NOT `[documentFormatting]` — and the first version of this line had it wrong, which is
  // the reason `screenReaderDefaults` was built rather than a nicety.
  //
  // Written to `documentFormatting` it LOOKED applied: `getSettings()` returned
  // `documentFormatting.reportLanguage: True`, read back off a live guest. NVDA reads it from `[speech]`,
  // so the setting was inert — a remedy that is present, reported, and does nothing, which is exactly
  // `refreshBrowseBuffer` guarding on a flag nobody set. **Verifying that a setting was WRITTEN is not
  // verifying it is IN EFFECT**, and the two look identical from the outside.
  //
  // It also invalidated the measurement taken from it. The before/after capture that came back
  // byte-identical was read as "reportLanguage is evidence-neutral on monolingual content". The simpler
  // explanation was that nothing had changed at all.
  //
  // Read from NVDA's own `configSpec.py` — `[speech] reportLanguage = boolean(default=false)`.
  { section: "speech", key: "reportLanguage", value: "True",
    why: "3.1.2 Language of Parts is announced as a VOICE change and no text unless this is on" },
  // NOT `documentFormatting.reportEmphasis`, and the reason is a browser limit rather than a decision.
  //
  // It was added here on 2026-09-03 with its corpus case, and the case came back CONTAMINATED: the signal
  // fired on BOTH variants, because NVDA said "emphasised" on neither. NVDA's emphasis reporting is
  // implemented only for the MSHTML rendering engine — Internet Explorer, or Edge in IE mode — and this
  // project captures in Chromium Edge, where NVDA does not announce `<em>` or `<strong>` at all.
  // See nvaccess/nvda#17216 and TPGi's "Screen Readers support for text level HTML semantics".
  //
  // So it is a NO-OP here, and an inert entry in this list is worse than an absent one: it would move
  // `screenReaderSettings`, which is a cache-key input, and invalidate every capture in exchange for
  // nothing. The finding is recorded in known-gaps rather than the setting kept "in case".
]);

/**
 * Apply `CAPTURE_SETTINGS` to every nvda.ini found, at boot.
 *
 * Not opt-in, unlike the log level above, and the difference is what each one costs. Debug logging
 * changes TIMING on a pipeline that measures timing, so it is set only while diagnosing. This changes
 * what NVDA SAYS, which is the thing being measured — so it must be on for every capture or the corpus
 * holds two kinds of evidence, and it must be in the cache key so it cannot blend with the old kind.
 *
 * @param {string[]} configPaths from diagnostics.screenReaderState
 * @param {(line: string) => void} log
 */
export function applyCaptureSettings(configPaths, log) {
  const changed = configPaths.flatMap((path) =>
    CAPTURE_SETTINGS.flatMap((setting) => applyOne(path, setting, log)));
  if (changed.length) {
    log(`NVDA capture settings applied (${[...new Set(changed)].join(", ")}); NVDA restarts to pick them up`);
  }
  return changed;
}

/**
 * One setting into one file. Split out so the loop above reads as what it does rather than as four
 * levels of nesting, and so the failure of one setting cannot skip the others.
 *
 * @param {string} path
 * @param {{section: string, key: string, value: string}} setting
 * @param {(line: string) => void} log
 * @returns {string[]} what changed — empty when it already said that, and empty when it could not be written
 */
function applyOne(path, setting, log) {
  try {
    const updated = withIniSetting(readFileSync(path, "utf8"), setting.section, setting.key, setting.value);
    if (!updated) return [];
    writeFileSync(path, updated, "utf8");
    return [`${setting.section}.${setting.key}`];
  } catch (error) {
    // RECORDED, never swallowed. A setting that failed to write means this guest captures under different
    // conditions from its peers, and `screenReaderSettings` in the cache key would then be a claim the
    // file does not support — so the log line is the only thing that can explain a fleet reading
    // INCONSISTENT afterwards.
    log(`could not set NVDA ${setting.section}.${setting.key} in ${path}: `
      + `${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
