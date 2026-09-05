/**
 * TWO COPIES OF ONE PREDICATE, ACROSS A BOUNDARY NEITHER "DELETE THE COPY" NOR "DERIVE ONE FROM THE OTHER"
 * CAN CROSS.
 *
 * `censusTargetIsSuspect` (`packages/evidence/src/verify.ts`) decides whether a CDP target's `targetMatch`/
 * `candidates` pair is trustworthy enough to vouch for a census. `focusTargetIsSuspect`
 * (`capture-pure.mjs`) is the identical judgement, needed because the F55 focus-event detector reads the
 * SAME `pageTarget()` machinery and, until 2026-09-06, checked none of it — a mistargeted capture correctly
 * suppressed a census finding while still reporting a real-looking 2.4.7 finding computed from the wrong
 * document. See `focusEventVerdict`'s own comment for the full seam this closed.
 *
 * The two cannot share code: this package runs as plain `.mjs` on the Windows guest under plain Node, and
 * `verify.ts` is TypeScript compiled to `dist` — depending on a build from here is exactly how a stale
 * `dist` scored the wrong rules once already (`name-normalisation.test.ts`'s own header). CLAUDE.md's third
 * remedy for "a fact stated twice" applies: pin the copies equal with a test, driven over one shared table,
 * so a future edit to either side that the other does not match fails loudly here rather than silently on
 * whichever capture happens to exercise the gap next.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { focusTargetIsSuspect } from "./capture-pure.mjs";
// The SOURCE, by relative path, never `@a11y-witness/evidence` — that specifier resolves to `dist`, and a
// test whose whole job is to catch drift between two files must not be reading a compiled snapshot of one.
import { censusTargetIsSuspect } from "../../evidence/src/verify.js";

/**
 * One table, both predicates. Each case names WHY it is or is not suspect, because "suspect" and "not
 * suspect" need opposite corpus/capture responses and a table with no rationale invites someone to "fix"
 * an entry without knowing which reading was intended.
 */
const CASES: { name: string; input: { targetMatch?: string | null; candidates?: number }; suspect: boolean }[] = [
  {
    name: "targetMatch absent entirely -- a capture predating this field, cannot retroactively accuse it",
    input: {},
    suspect: false,
  },
  {
    name: "matched, one candidate -- the ordinary case",
    input: { targetMatch: "matched", candidates: 1 },
    suspect: false,
  },
  {
    name: "matched, several candidates -- a confirmed match is never suspect regardless of how many pages were open",
    input: { targetMatch: "matched", candidates: 4 },
    suspect: false,
  },
  {
    name: "fallback with exactly one candidate -- fallback IS the only page there ever was, so it is safe",
    input: { targetMatch: "fallback", candidates: 1 },
    suspect: false,
  },
  {
    name: "fallback with several candidates -- one of many was chosen by default, worth doubting",
    input: { targetMatch: "fallback", candidates: 3 },
    suspect: true,
  },
  {
    name: "fallback with candidates missing -- the transitional gap: present targetMatch, absent candidates",
    input: { targetMatch: "fallback" },
    suspect: true,
  },
  {
    name: "no-expected-url with one candidate -- nothing was asked for and there was nowhere else it could be",
    input: { targetMatch: "no-expected-url", candidates: 1 },
    suspect: false,
  },
  {
    name: "no-expected-url with several candidates -- nothing was asked for AND there were other pages",
    input: { targetMatch: "no-expected-url", candidates: 5 },
    suspect: true,
  },
  {
    name: "targetMatch explicitly null -- a genuine read failure (evaluateOnPageTarget threw), not the same as absent",
    input: { targetMatch: null, candidates: undefined },
    suspect: true,
  },
];

test("focusTargetIsSuspect and censusTargetIsSuspect agree on every case", () => {
  for (const { name, input, suspect } of CASES) {
    assert.equal(focusTargetIsSuspect(input), suspect, `focusTargetIsSuspect: ${name}`);
    assert.equal(censusTargetIsSuspect(input), suspect, `censusTargetIsSuspect: ${name}`);
  }
});
