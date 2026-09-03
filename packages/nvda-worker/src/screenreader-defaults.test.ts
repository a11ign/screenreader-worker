// WHICH NVDA DEFAULTS ARE HIDING EVIDENCE?
//
// `documentFormatting.reportLanguage` defaults OFF, and because of that a WCAG 3.1.2 failure is announced
// as a change of VOICE with no text at all — so this project recorded 3.1.2 as out of reach for months, on
// a premise nobody had checked. Nothing rules out a sibling.
//
// `getSettings()` cannot answer it: guidepup's `getSetting` is `getConfig()[key]` over the WRITTEN ini, so
// a setting at its default has no key and "off" is indistinguishable from "never asked". The defaults live
// only in `configSpec.py`, which is why this parses a file.
//
// Parsed against NVDA's REAL syntax rather than a shape invented here — the repo's rule about tests
// written against a shape you did not verify.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { screenReaderDefaults } from "./diagnostics.mjs";

/** Real lines from NVDA's `configSpec.py`, including the one that started this. */
const SPEC = `
[general]
	language = string(default="Windows")
	saveConfigurationOnExit = boolean(default=True)

[speech]
	synth = string(default=auto)
	symbolLevel = integer(default=100)

[documentFormatting]
	detectFormatAfterCursor = boolean(default=false)
	reportFontName = boolean(default=false)
	reportLanguage = boolean(default=false)
	reportLinks = boolean(default=true)
	reportHeadings = boolean(default=true)
	reportTables = boolean(default=true)
	reportColor = boolean(default=False)
`;

function specIn(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "nvda-spec-"));
  const nested = join(root, "nvda", "extracted", "source", "config");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "configSpec.py"), body, "utf8");
  return root;
}

test("reads the default that started this — reportLanguage is FALSE", () => {
  const out = screenReaderDefaults(specIn(SPEC));
  assert.equal(out.found, true, "the spec must be found through NVDA's nesting");
  assert.equal(out.sections?.documentFormatting?.reportLanguage, "false");
});

test("separates the ON defaults from the OFF ones, which is the whole question", () => {
  const df = screenReaderDefaults(specIn(SPEC)).sections?.documentFormatting ?? {};
  // These being ON is why the sweeps work at all, and it was ASSUMED until this could read it.
  assert.equal(df.reportLinks, "true");
  assert.equal(df.reportHeadings, "true");
  assert.equal(df.reportTables, "true");
  // And these are the candidates: off by default, so evidence they would carry is silent today.
  assert.equal(df.reportFontName, "false");
  assert.equal(df.reportColor, "False", "NVDA's casing is inconsistent and must be preserved, not normalised");
});

test("non-boolean settings are captured too, so a future type is reported rather than dropped", () => {
  const out = screenReaderDefaults(specIn(SPEC));
  assert.equal(out.sections?.speech?.symbolLevel, "100");
  assert.equal(out.sections?.speech?.synth, "auto");
  assert.equal(out.sections?.general?.language, "Windows");
});

test("a missing spec says NOT FOUND rather than 'nothing defaults to false'", () => {
  // The distinction this whole file exists for. An NVDA build that ships the spec inside library.zip is a
  // real possibility, and "we could not look" must never render as "there is nothing to find".
  const empty = mkdtempSync(join(tmpdir(), "nvda-nospec-"));
  assert.deepEqual(screenReaderDefaults(empty), { found: false });
  assert.deepEqual(screenReaderDefaults(null), { found: false });
});

test("an unreadable tree does not throw — a diagnostic must not take a worker down", () => {
  assert.doesNotThrow(() => screenReaderDefaults("/definitely/not/a/path/here"));
});
