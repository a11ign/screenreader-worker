/**
 * The completeness census must be taken BEFORE `probeRouteChange`, the one probe in `navigateByStructure`
 * that can leave the page under measurement.
 *
 * Found 2026-09-06: the three `pageTarget()`-dependent censuses (`structuralCensus`/`domCensus`/
 * `mediaCensus`, taken together by `censusBeforeNavigating`) used to be called from the CALLER
 * (`navigateByStructureThenAudit`), after `navigateByStructure` had already returned -- which put them
 * after `probeRouteChange` too. On any real page whose route-change probe followed a real link rather than
 * a same-page fragment, the census silently described wherever that link led: two GOV.UK Design System
 * pages' post-navigation censuses were byte-identical to each other despite differing by 11 headings and
 * 136 links on the real page, both reading the site's own `/cookies` settings page reached by "View
 * cookies, visited, link" -- the exact control `probeRouteChange` activates to test 2.4.2. `known-gaps.md`
 * §40 has the full measurement (20 of 20 real pages sampled, 25 of 2,796 synthetic).
 *
 * This cannot be tested by driving a real capture -- that needs live NVDA on Windows, which this repo has
 * no local substitute for. What CAN be tested, offline, is the one fact that actually fixes the bug: the
 * source text calls `censusBeforeNavigating()` before it calls `probeRouteChange(`, inside
 * `navigateByStructure`'s own body. A position in a file is normally a convention nobody wrote down
 * (CLAUDE.md's own words, about a different ordering question) -- here it is exactly what decides the
 * defect, because `navigateByStructure` is a single straight-line `async` function with no branching that
 * could reorder these two calls at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(fileURLToPath(new URL("./capture-probes.mjs", import.meta.url)), "utf8");

/** `navigateByStructure`'s own body, isolated so a match elsewhere in the file (a comment, another
 * function) cannot be mistaken for the real call sites. */
function navigateByStructureBody(): string {
  const start = SOURCE.search(/\basync function navigateByStructure\(/);
  assert.ok(start >= 0, "could not find \"async function navigateByStructure(\" -- the function was "
    + "renamed or removed, which this guard needs to know about rather than silently checking nothing");
  const rest = SOURCE.slice(start);
  // Up to the next top-level function -- good enough for a single-function scope, the same technique
  // `worker-http-client-owner.test.ts` uses for the identical reason.
  const nextTop = rest.slice(1).search(/\n(export )?(async )?function /);
  return rest.slice(0, nextTop === -1 ? undefined : nextTop + 1);
}

test("censusBeforeNavigating() is called before probeRouteChange( inside navigateByStructure", () => {
  const body = navigateByStructureBody();
  const censusCall = body.indexOf("censusBeforeNavigating()");
  const routeChangeCall = body.indexOf("probeRouteChange(");
  assert.ok(censusCall >= 0,
    "navigateByStructure no longer calls censusBeforeNavigating() -- the census may have been removed "
    + "or renamed, which this guard needs to know about rather than silently passing");
  assert.ok(routeChangeCall >= 0,
    "navigateByStructure no longer calls probeRouteChange( -- the guard this test protects no longer "
    + "has anything to protect against, which is worth knowing rather than a silent pass");
  assert.ok(censusCall < routeChangeCall,
    "censusBeforeNavigating() must be called BEFORE probeRouteChange( -- moving it back reopens the "
    + "defect known-gaps.md §40 describes: the census would again describe whatever page the route-change "
    + "probe navigated to, not the page under test");
});

test("censusBeforeNavigating itself takes all three censuses, so none of the three can be left behind", () => {
  // A guard that only checked ONE of the three would let a future edit move `domCensus`/`mediaCensus`
  // back out of the helper and past `probeRouteChange` individually -- the exact "remedy reaches one call
  // site" shape this repo's own defect catalogue is built from.
  const start = SOURCE.search(/\basync function censusBeforeNavigating\(/);
  assert.ok(start >= 0, "could not find \"async function censusBeforeNavigating(\" -- renamed or removed");
  const rest = SOURCE.slice(start);
  const nextTop = rest.slice(1).search(/\n(export )?(async )?function /);
  const body = rest.slice(0, nextTop === -1 ? undefined : nextTop + 1);
  for (const call of ["structuralCensus()", "domCensus()", "mediaCensus()"]) {
    assert.ok(body.includes(call), `censusBeforeNavigating no longer calls ${call}`);
  }
});
