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
import { deflateRawSync } from "node:zlib";

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

// --- NVDA ships BUILT, so the spec is inside library.zip. Measured 2026-09-03, after the loose-file
// --- search answered `found: false` on all five workers.

test("reads the spec out of library.zip, because that is where a built NVDA keeps it", () => {
  // A REAL deflate zip, written by node's own zlib rather than a fixture blob committed to the repo: a
  // hand-rolled zip reader is exactly the thing that passes against a fixture shaped to suit it.
  const root = mkdtempSync(join(tmpdir(), "nvda-zip-"));
  const extracted = join(root, "nvda", "all", "0.2.1", "extracted");
  mkdirSync(extracted, { recursive: true });
  writeFileSync(join(extracted, "library.zip"), zipOf({
    // Two entries, and the wanted one SECOND — a reader that stops at the first entry would pass with one.
    "other/module.py": "x = 1\n",
    "config/configSpec.py": SPEC,
  }));

  const out = screenReaderDefaults(root);
  assert.equal(out.found, true, "the spec must be found inside the zip");
  assert.match(out.path ?? "", /library\.zip$/);
  assert.equal(out.sections?.documentFormatting?.reportLanguage, "false");
  assert.equal(out.sections?.documentFormatting?.reportLinks, "true");
});

test("a zip WITHOUT the spec is not-found, not empty", () => {
  const root = mkdtempSync(join(tmpdir(), "nvda-zip-empty-"));
  mkdirSync(join(root, "nvda"), { recursive: true });
  writeFileSync(join(root, "nvda", "library.zip"), zipOf({ "other/module.py": "x = 1\n" }));
  const out = screenReaderDefaults(root);
  assert.equal(out.found, false, "no spec in the zip must not read as 'nothing defaults to false'");
  assert.match(out.path ?? "", /library\.zip$/, "the path says WHERE we looked and failed");
});

/**
 * Build a real zip with node's zlib — central directory, local headers and raw deflate.
 *
 * In the test rather than in `diagnostics.mjs` on purpose: the worker only ever READS a zip, and adding a
 * writer to the capture path to make a test easier is how a module grows a second job.
 */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const raw = Buffer.from(body, "utf8");
    const deflated = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);                    // deflate
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, deflated]));

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuf]));
    offset += local.length + nameBuf.length + deflated.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
