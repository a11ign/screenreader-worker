/**
 * #426: `/progress`'s `phases` array used to strip every mark down to `{event, atMs}`, discarding
 * whatever `diag.mark(event, detail)` recorded alongside it. That data was never actually missing --
 * `createDiagnostics`' own `mark` function already does `entries.push({ event, atMs, ...info })`, so a
 * real capture's `structureCensus` mark (fired before the sweep can be trapped by anything) has always
 * carried the full census in memory. `respondWithProgress` threw it away at the very last step.
 *
 * The first test below used to assert that by matching `capture-core.mjs`'s SOURCE, and #854 broke it by
 * moving `createDiagnostics` to `capture-pure.mjs` -- correctly, and the regex could not tell a move from
 * a deletion. It drives the real recorder now: `capture-pure.mjs` imports no guidepup, so the property
 * this fix depends on can be OBSERVED rather than pattern-matched, which is what it should always have
 * been. The `respondWithProgress` half below still reads source, because `server.mjs` cannot be imported.
 *
 * This is the specific, offline-buildable first half of #426: the route now echoes what was OBSERVED,
 * never a verdict computed from it -- deciding what a heading count MEANS (an early "contained"
 * heuristic) is #426's own separate, fleet-validated next step, and belongs where it can be argued with
 * rather than baked into this endpoint's wire format.
 *
 * `server.mjs` needs guidepup and therefore a screen reader, so -- same reasoning `in-flight-clears.test.ts`
 * already gives for the identical constraint -- this asserts the property against the SOURCE rather than
 * by running a capture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDiagnostics } from "./capture-pure.mjs";

const server = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");

/** `respondWithProgress`'s own body, extracted the same way `in-flight-clears.test.ts` reads `runCapture`. */
function respondWithProgressBody(): string {
  const body = /function respondWithProgress\([\s\S]*?\n}\n/.exec(server)?.[0];
  assert.ok(body, "respondWithProgress not found; this scan is broken, not passing");
  return body as string;
}

test("the mark log actually carries a mark's detail fields, not just its name and timestamp -- the fact "
  + "this whole fix depends on", () => {
  // Pinning the recorder's OWN half of the fact, so a future change there cannot silently make
  // `respondWithProgress`'s widening report nothing new: the two must agree on what a mark holds, the
  // same "fact stated twice" shape this repository has been burned by repeatedly.
  const diag = createDiagnostics();
  diag.mark("structureCensus", { heading: 83, formControl: 224, readAt: { startedAtMs: 5211, tookMs: 47 } });

  const [census] = diag.entries as Record<string, unknown>[];
  assert.equal(census.event, "structureCensus");
  assert.equal(typeof census.atMs, "number");
  assert.equal(census.heading, 83,
    "mark() no longer spreads `info` into the pushed entry -- if this changes, structureCensus's actual "
    + "data would stop reaching inFlight.marks at all, and respondWithProgress would have nothing left to "
    + "echo regardless of what it does with the array");
  assert.deepEqual(census.readAt, { startedAtMs: 5211, tookMs: 47 },
    "a nested detail must survive the spread too -- #854 puts the census's read moment there");
});

test("MUTATION TARGET: phases echoes the FULL mark, not a name-and-timestamp-only projection", () => {
  const body = respondWithProgressBody();
  // The OLD, filtered form this fix replaces -- if this pattern is what `phases:` still builds, the
  // widening never happened and structureCensus's data is still discarded at the last step.
  assert.doesNotMatch(body, /phases:\s*marks\.map\(\([^)]*\)\s*=>\s*\(\{\s*event:\s*\w+\.event,\s*atMs:\s*\w+\.atMs\s*\}\)\)/,
    "phases still projects each mark down to {event, atMs} only -- the census (and every other mark's "
    + "detail) is being discarded exactly as before this fix");
  // The NEW form: every field on the mark, spread into a fresh object (never the same reference the
  // module's own in-flight state holds, so a caller cannot mutate it through the HTTP response).
  assert.match(body, /phases:\s*marks\.map\(\([^)]*\)\s*=>\s*\(\{\s*\.\.\.\w+\s*\}\)\)/,
    "phases no longer spreads the full mark object -- structureCensus's data (and every other mark's "
    + "detail) will not reach a consumer of /progress");
});

test("CONTROL: the not-in-flight branch is untouched -- this fix only changes what an ACTIVE capture "
  + "reports, never the idle shape", () => {
  assert.match(server, /if\s*\(!inFlight\)\s*return\s*send\(res,\s*200,\s*\{\s*busy,\s*capturing:\s*null\s*\}\)/,
    "the idle /progress response has changed shape -- this fix should not have touched it at all");
});

test("lastPhase/lastPhaseAtMs are read straight off the mark, not reconstructed from the widened phases "
  + "array -- the two must not drift into two different readings of the same fact", () => {
  const body = respondWithProgressBody();
  assert.match(body, /lastPhase:\s*last\s*&&\s*last\.event/);
  assert.match(body, /lastPhaseAtMs:\s*last\s*&&\s*last\.atMs/);
});
