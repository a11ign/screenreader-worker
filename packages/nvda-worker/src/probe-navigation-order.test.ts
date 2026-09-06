/**
 * EVERYTHING THAT READS THE PAGE MUST READ IT BEFORE THE ONE PROBE THAT CAN NAVIGATE AWAY.
 *
 * `known-gaps.md` §40: the three `pageTarget()` censuses used to run after `probeRouteChange`, so on a page
 * whose first link navigated they described wherever that link led rather than the page under test — two
 * GOV.UK Design System pages produced byte-identical post-navigation censuses despite differing by 11
 * headings and 136 links. The fix moved them. `crossCheckAgainstElementsList` compares `structure` (captured
 * at sweep time) against a LIVE Elements List read, so it has the identical exposure — and it was the one
 * call site the §40 fix did not reach, found by `docs/probe-side-effects.md`'s audit.
 *
 * SOURCE TEXT, deliberately, and with the anti-vacuity guards that requires. `navigateByStructure` cannot be
 * imported: `capture-core.mjs` pulls in guidepup, which throws at module load where no screen reader exists
 * (`pure-graph.test.ts` records this), so there is nothing to call. `focus-reveal.test.ts`'s own sequencing
 * test and `forbidden-input-keys-parity.test.ts` document the same exception for the same reason. Every
 * marker below is asserted to EXIST before it is compared, so a rename makes this test fail loudly rather
 * than pass having examined nothing.
 *
 * The markers are CALL SYNTAX (`name({` / `name()`), never the bare name. A bare name matches this file's
 * own prose: the comment above `censusBeforeNavigating` names `probeRouteChange` three times, and the one
 * above `crossCheckAgainstElementsList` names it too. A previous unit shipped a test whose `indexOf` stayed
 * non-negative after the call was mutated away, precisely because a doc comment mentioned the name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "./capture-probes.mjs"), "utf8");

/** The body of `navigateByStructure`, up to the next top-level function declaration. */
function navigateByStructureBody(): string {
  const start = SOURCE.indexOf("async function navigateByStructure({");
  assert.ok(start >= 0,
    "navigateByStructure not found in capture-probes.mjs -- this test examines nothing until it is");
  const rest = SOURCE.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  return rest.slice(0, nextFn >= 0 ? nextFn : rest.length);
}

/** Where a CALL to `name` appears in `body` — never a prose mention of it. */
function callAt(body: string, name: string): number {
  const at = body.indexOf(`${name}({`);
  assert.ok(at >= 0,
    `no CALL to ${name} in navigateByStructure -- either it moved out of this function, or this test is `
    + "matching prose instead of code; find the call and update the marker rather than deleting the assert");
  return at;
}

test("crossCheckAgainstElementsList reads the page BEFORE probeRouteChange can navigate away from it", () => {
  const body = navigateByStructureBody();
  const crossCheckAt = callAt(body, "crossCheckAgainstElementsList");
  const routeChangeAt = callAt(body, "probeRouteChange");
  assert.ok(crossCheckAt < routeChangeAt,
    "crossCheckAgainstElementsList must run BEFORE probeRouteChange. It ran after, and its live Elements "
    + "List read then described whatever page the route-change probe had navigated to, while the `structure` "
    + "half of the same comparison still described the page under test -- known-gaps.md §40's defect, in the "
    + "call site that fix did not reach.");
});

test("the censuses still read the page before probeRouteChange too — §40's original fix, still in place", () => {
  // The sibling assertion, so a future edit that moves the cross-check correctly and the census wrongly
  // cannot pass this file. §40 is the reason the rule exists; this is the rule still holding.
  const body = navigateByStructureBody();
  const censusAt = body.indexOf("censusBeforeNavigating()");
  assert.ok(censusAt >= 0,
    "no CALL to censusBeforeNavigating in navigateByStructure -- find it and update the marker");
  assert.ok(censusAt < callAt(body, "probeRouteChange"),
    "censusBeforeNavigating must run BEFORE probeRouteChange -- known-gaps.md §40");
});
