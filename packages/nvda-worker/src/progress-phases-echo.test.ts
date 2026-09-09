/**
 * #426: `/progress`'s `phases` array used to strip every mark down to `{event, atMs}`, discarding
 * whatever `diag.mark(event, detail)` recorded alongside it. That data was never actually missing --
 * `capture-core.mjs`'s own `mark` function already does `entries.push({ event, atMs, ...info })`, so a
 * real capture's `structureCensus` mark (fired before the sweep can be trapped by anything) has always
 * carried the full census in memory. `respondWithProgress` threw it away at the very last step.
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

const server = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");
const captureCore = readFileSync(fileURLToPath(new URL("./capture-core.mjs", import.meta.url)), "utf8");

/** `respondWithProgress`'s own body, extracted the same way `in-flight-clears.test.ts` reads `runCapture`. */
function respondWithProgressBody(): string {
  const body = /function respondWithProgress\([\s\S]*?\n}\n/.exec(server)?.[0];
  assert.ok(body, "respondWithProgress not found; this scan is broken, not passing");
  return body as string;
}

test("the mark log actually carries a mark's detail fields, not just its name and timestamp -- the fact "
  + "this whole fix depends on", () => {
  // Pinning `capture-core.mjs`'s OWN half of the fact, so a future change there cannot silently make
  // `respondWithProgress`'s widening report nothing new: the two files must agree on what a mark holds,
  // the same "fact stated twice" shape this repository has been burned by repeatedly.
  assert.match(captureCore,
    /entries\.push\(\{\s*event,\s*atMs:\s*Date\.now\(\)\s*-\s*startedAt,\s*\.\.\.info\s*\}\)/,
    "capture-core.mjs's mark() no longer spreads `info` into the pushed entry -- if this changes, "
    + "structureCensus's actual data would stop reaching inFlight.marks at all, and respondWithProgress "
    + "would have nothing left to echo regardless of what it does with the array");
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
