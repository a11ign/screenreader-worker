/**
 * THE CENSUS RECORDS WHEN IT WAS READ, NOT WHEN IT WAS MARKED — #854.
 *
 * `createDiagnostics`' `mark` stamps `atMs` inside `entries.push`, so `atMs` is when the mark was PUSHED.
 * The three census marks are read at the top of `navigateByStructure` and pushed by
 * `navigateByStructureThenAudit` after every sweep and probe has run. Measured across one checkout's
 * whole `runs/witness` — 25 captures, no exceptions — `structureCensus.atMs` landed within 60 ms of the
 * LAST mark in its file, describing a read that happened 93–469 s earlier.
 *
 * That is not a fluke to be sampled around. It is what the field says about **every capture ever taken**,
 * and it produced three wrong readings in one afternoon: the worst was comparing it against the first
 * sweep's mark to decide which side of #699 five captures fell on, concluding "#699 isn't in any of them"
 * when it is in three (#800, #836, corrected by #850).
 *
 * Half of this file READS THE SOURCE — the `activation-gates.test.ts` exemption, because this package
 * imports guidepup and throws at module load where no screen reader exists, so nothing can call
 * `censusBeforeNavigating`. The other half does not need to: `createDiagnostics` now lives in
 * `capture-pure.mjs` and is driven directly, which is the point of moving it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDiagnostics } from "./capture-pure.mjs";

const PROBES = readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8");

/** The body of a named function, to the first line that closes it at column 0. */
const bodyOf = (source: string, declaration: string) => {
  const at = source.indexOf(declaration);
  assert.notEqual(at, -1, `${declaration} — the function this test is about no longer exists under that name`);
  const from = source.slice(at);
  return from.slice(0, from.indexOf("\n}\n"));
};

test("THE FAULT IS REAL: a value read early and marked late gets the late time", () => {
  // The guard has to be able to express the defect, or it proves nothing — the canary rule. This drives
  // the real recorder rather than describing it.
  const diag = createDiagnostics();
  const readAtMs = diag.sinceStart();
  const busyUntil = Date.now() + 25;
  while (Date.now() < busyUntil) { /* the sweeps, in miniature */ }
  diag.mark("structureCensus", { heading: 83, readAt: { startedAtMs: readAtMs, tookMs: 0 } });

  const [censusMark] = diag.entries as unknown as { atMs: number, readAt: { startedAtMs: number } }[];
  assert.ok(censusMark.atMs >= 25,
    "`atMs` is the PUSH time — if this ever equals the read time the defect has been fixed elsewhere and "
    + "this file is testing nothing");
  assert.ok(censusMark.readAt.startedAtMs < censusMark.atMs,
    "the read happened before the mark, and the record has to be able to say so");
});

test("the moment comes from the READ, not from a second clock at the mark site", () => {
  // The whole defect is one `Date.now()` standing in for another. A `readAt` computed where the mark is
  // written would reproduce it exactly, while looking correct in a diff.
  const census = bodyOf(PROBES, "async function censusBeforeNavigating");
  assert.match(census, /const censusAt = diag\.sinceStart\(\);\s*\n\s*const census = await structuralCensus\(\);/,
    "each census's moment must be read BEFORE its await, or it records when the read finished");
  assert.match(census, /const domAt = diag\.sinceStart\(\);\s*\n\s*const dom = await domCensus\(\);/);
  assert.match(census, /const mediaAt = diag\.sinceStart\(\);\s*\n\s*const media = await mediaCensus\(\);/);

  const audit = bodyOf(PROBES, "export async function navigateByStructureThenAudit");
  assert.doesNotMatch(audit, /Date\.now\(\)/,
    "the mark site must not mint its own moment — that is the defect, spelled differently");
});

test("ALL THREE census marks carry it, not just the one that produced a wrong answer", () => {
  // A remedy at one call site when the behaviour reaches several is this repo's most expensive shape.
  // `structureCensus` is the mark that misled a reader; `domCensus` and `mediaCensus` are read in the
  // same call and pushed in the same place, so they carry the identical defect and no reader had yet
  // asked them the question.
  const audit = bodyOf(PROBES, "export async function navigateByStructureThenAudit");
  assert.match(audit, /mark\("structureCensus", \{ \.\.\.census, \.\.\.readAt\.census \}\)/);
  assert.match(audit, /mark\("domCensus", \{ [^\n]*\.\.\.readAt\.dom \}\)/);
  assert.match(audit, /\.\.\.readAt\.media/, "mediaCensus must carry its read moment too");
  // Marked even when the read FAILED. "Not counted" still happened at a moment, and an error branch that
  // drops the moment is how a gate downstream comes to treat a failure as an absence.
  assert.match(audit, /error: "not counted", \.\.\.readAt\.media/);
});

test("the moment is NESTED, because the census counts are read off a denylist", () => {
  // `censusElementCounts` and `censusFromDiagnostics` build the element counts by taking every numeric
  // field on the mark except `event` and `atMs`. A flat `readAtMs: 3200` would arrive downstream as an
  // element type named `readAtMs` with 3,200 of them. `distinct` is nested for this reason already.
  const census = bodyOf(PROBES, "async function censusBeforeNavigating");
  assert.match(census, /census: \{ readAt: \{ startedAtMs: censusAt, tookMs: domAt - censusAt \} \}/);
  assert.doesNotMatch(census, /^\s*readAtMs:/m,
    "a flat numeric field on a census mark is read as an element count");
});

test("there is ONE diagnostics recorder, and `capture-setup.mjs` no longer keeps a copy", () => {
  // It was duplicated deliberately — "a pure, dependency-free 5-line function" — to avoid an import edge
  // that does not exist: both files already import `capture-pure.mjs`. Adding `sinceStart` to one copy
  // and not the other would have been a sixth instance of the shape that cost five incidents in a day.
  for (const file of ["capture-core.mjs", "capture-setup.mjs"]) {
    const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
    assert.doesNotMatch(source, /function createDiagnostics\(/,
      `${file} must import the recorder, not define a second one`);
    assert.match(source, /createDiagnostics,/, `${file} must import it`);
  }
});

test("`sinceStart` is required on the recorder, so a caller cannot silently record nothing", () => {
  // Optional would typecheck everywhere and quietly leave `readAt` off every mark — the field would be
  // absent, every downstream gate would stay closed, and nothing would say why.
  const pure = readFileSync(resolve(import.meta.dirname, "capture-pure.mjs"), "utf8");
  assert.match(pure, /sinceStart: \(\) => number \}\} CaptureDiagnostics/,
    "the recorder's type must require the clock");
  assert.doesNotMatch(pure, /sinceStart\?/);
});
