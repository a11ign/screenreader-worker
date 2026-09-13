/**
 * `probeFocusOrder` and `probeFocusContext` both Tab-walk relative to whatever DOM focus an earlier probe
 * left behind — the same exposure `§43` fixed in `probeFocusReveal`, found by `docs/probe-side-effects.md`'s
 * audit. `anchorToTop` (which both already called) resets NVDA's caret and mode and never DOM focus, so
 * without this fix each probe's first Tab moves relative to whatever the sweep's own disclosure activation
 * (unconditional, not gated on an opt-in flag) left focused — and `probeFocusOrder` is the channel 2.1.1,
 * 2.1.2, 2.4.1 and 2.4.3 all read.
 *
 * Neither probe can be driven without real NVDA — `capture-core.mjs` imports guidepup, which throws at
 * module load with no screen reader present (see `pure-graph.test.ts`) — so nothing here can import and
 * call them. This is the SAME documented exception `focus-reveal.test.ts`'s own sequencing test already
 * uses for the identical reason: read the source and assert the call is where it has to be, never merely
 * present somewhere in the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "./capture-probes.mjs"), "utf8");

/**
 * Comments out, so a source-read guard cannot be satisfied by PROSE.
 *
 * #1205, found by `worker-capture`: `functionBody` did not strip and five tests read it, so replacing
 * `probeFocusReveal`'s reset with a COMMENT naming the call left the suite 7/0 green with the reset
 * gone -- defeating the direct clause and the caller-side clause together, because both read the same
 * unstripped text. It is #1197's defect (a guard reading its own paragraph) in the half of this file
 * nobody had touched, and it is this row's own shape one level up: the function that got stripping is
 * guarded against prose, and the five that did not, were not.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The body of one `async function <name>(...) {...}`, up to the next top-level function declaration. */
function functionBody(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in capture-probes.mjs -- this test examines nothing until it is`);
  const rest = SOURCE.slice(start + 1);
  const nextFn = rest.search(/\n(?:async )?function /);
  return stripComments(rest.slice(0, nextFn >= 0 ? nextFn : rest.length));
}

test("probeFocusOrder resets DOM focus before its Tab walk, not just its own caret", () => {
  const body = functionBody("probeFocusOrder");
  const resetAt = body.indexOf("resetFocusToDocumentStart()");
  const loopAt = body.indexOf("for (let i = 0; i < MAX_TAB_STOPS");
  assert.ok(resetAt >= 0,
    "probeFocusOrder must call resetFocusToDocumentStart -- the §43 fix, applied to the channel " +
    "2.1.1/2.1.2/2.4.1/2.4.3 all read");
  assert.ok(loopAt >= 0, "the Tab-walk loop marker moved -- update this test to find the walk, not to pass");
  assert.ok(resetAt < loopAt,
    "the reset must run BEFORE the walk begins, or it cannot protect the walk's first stop");
});

test("probeFocusContext resets DOM focus before its Tab walk, not just its own caret", () => {
  const body = functionBody("probeFocusContext");
  const resetAt = body.indexOf("resetFocusToDocumentStart()");
  const loopAt = body.indexOf("for (; stops < FOCUS_CONTEXT_STOPS");
  assert.ok(resetAt >= 0, "probeFocusContext must call resetFocusToDocumentStart -- the same §43 fix");
  assert.ok(loopAt >= 0, "the Tab-walk loop marker moved -- update this test to find the walk, not to pass");
  assert.ok(resetAt < loopAt,
    "the reset must run BEFORE the walk begins, or it cannot protect the walk's first stop");
});

test("both probes record startedFrom and focusReset on their own mark, not just call the reset blindly", () => {
  // A reset that runs but is never recorded is the same silence this repo has already paid for once:
  // "did not need to" and "never ran" must stay distinguishable, and that needs the mark to carry both
  // fields -- not just the call to exist somewhere in the function body.
  for (const name of ["probeFocusOrder", "probeFocusContext"]) {
    const body = functionBody(name);
    assert.match(body, /startedFrom/, `${name} must record where the walk started, on its diagnostic mark`);
    assert.match(body, /focusReset/, `${name} must record whether the reset applied, on its diagnostic mark`);
  }
});

/**
 * #1205 (#31's code half): THE GUARD REACHED THE SIBLINGS AND NOT THE ORIGINAL.
 *
 * §43 is about `probeFocusReveal` — 1.4.13's probe, the one whose two captures of the same URL
 * disagreed because one path left focus on `Security question` (panel one Tab away) and the other on
 * `Daytime telephone` (eight Tabs never reached it). **Its fix is merged and nothing held it there.**
 * The two tests above guard `probeFocusOrder` and `probeFocusContext`, which INHERITED the fix from it;
 * `probeFocusReveal` appeared in this file exactly once, in a comment. Deleting its reset failed nothing.
 *
 * That is this repository's "a fix applied at one call site when the behaviour reaches several",
 * inverted: the guard reached the copies and not the original.
 *
 * SO THIS PINS THE CLASS RATHER THAN A THIRD INSTANCE. The population is DERIVED — every function in
 * `capture-probes.mjs` that presses Tab — because a hand-typed list of three is how the first two came
 * to be guarded and the third did not. Five functions press Tab today and only two were named here.
 *
 * EVERY MEMBER IS CLASSIFIED AND THE EXEMPTIONS CARRY THEIR REASON, because a walk that resets is not
 * the only correct answer: two of the five must NOT reset, and a guard that demanded it of them would
 * fire on correct code — the mistake this repo has paid for most often.
 */

/** Every function in `capture-probes.mjs` whose own body presses Tab, with that body. */
function tabWalkers(): { name: string; body: string }[] {
  const declarations = [...SOURCE.matchAll(/\n(?:async )?function ([A-Za-z0-9_]+)\(/g)]
    .map((m) => ({ name: m[1], at: m.index ?? 0 }));
  return declarations
    .map((d, i) => ({
      name: d.name,
      body: stripComments(SOURCE.slice(d.at, i + 1 < declarations.length ? declarations[i + 1].at : SOURCE.length)),
    }))
    .filter((f) => /nvda\.press\("Tab"\)/.test(f.body));
}

/**
 * Why a Tab-walker may legitimately start from wherever focus already is.
 *
 * Each entry is a claim about the probe's PURPOSE, not a note that it currently lacks a reset — an
 * exemption that only says "this one does not do it" is the defect wearing a table.
 */
const MAY_START_ANYWHERE: Record<string, string> = {
  focusedAfterTab:
    "one-shot, and RELATIVE BY DESIGN: its single caller asks `routeChangeFocusAfter` -- where did focus "
    + "go after the route change -- so 'the next stop from here' IS the measurement. A reset would "
    + "destroy the question rather than protect it.",
  probeElementsListCounts:
    "its Tab moves focus INSIDE NVDA's elements-list dialog (from the radio group to the tree, so Home "
    + "reaches the first row), not along the page's tab order. The page's starting position is not an "
    + "input to it.",
};

/** A walk whose reset is performed by its caller, named with the caller that performs it. */
const RESET_BY_CALLER: Record<string, string> = {
  walkToReveal: "probeFocusReveal",
};

test("#1205: every Tab-walking probe is accounted for -- the population is derived, not typed", () => {
  const walkers = tabWalkers();
  // Guard the guard: a regex that stops matching makes every assertion below vacuous, and the walk
  // would still be "finding functions".
  assert.ok(walkers.length >= 5,
    `only ${walkers.length} Tab-walking function(s) found in capture-probes.mjs; the scan is broken and `
    + "every check below would pass having examined nothing");
  const unaccounted = walkers
    .map((w) => w.name)
    .filter((n) => !(n in MAY_START_ANYWHERE) && !(n in RESET_BY_CALLER)
      && !/resetFocusToDocumentStart\(\)/.test(walkers.find((w) => w.name === n)?.body ?? ""));
  assert.deepEqual(unaccounted, [],
    `${unaccounted.length} function(s) walk the tab order and neither reset DOM focus first nor carry a `
    + "stated reason for starting wherever focus already is. Add the reset, or add an entry to "
    + `MAY_START_ANYWHERE saying what the probe MEASURES that makes the start position part of it:\n  `
    + unaccounted.join("\n  "));
});

test("#1205: probeFocusReveal resets before walkToReveal -- §43's own probe, guarded at last", () => {
  const body = functionBody("probeFocusReveal");
  const resetAt = body.indexOf("resetFocusToDocumentStart()");
  const walkAt = body.indexOf("walkToReveal(");
  assert.ok(resetAt >= 0,
    "probeFocusReveal must call resetFocusToDocumentStart -- §43 is ABOUT this probe, and until #1205 "
    + "nothing here held the fix in place while both probes that copied it were guarded");
  assert.ok(walkAt >= 0, "the walk moved or was renamed -- update this test to find it, not to pass");
  assert.ok(resetAt < walkAt,
    "the reset must run BEFORE walkToReveal, or the walk's first Tab still moves from wherever the "
    + "previous probe left focus -- the exact difference between §43's two captures of one URL");
  assert.match(body, /startedFrom/,
    "and it must record where the walk started: `revealed: false` and `revealed: false FROM HERE` are "
    + "different evidence, which is what §43 says the fix has to make distinguishable");
  assert.match(body, /focusReset/,
    "and whether the reset applied -- 'did not need to' and 'never ran' must stay apart");
});

test("#1205: every exemption names a function that still exists, so the table cannot rot", () => {
  const present = new Set(tabWalkers().map((w) => w.name));
  const phantom = [...Object.keys(MAY_START_ANYWHERE), ...Object.keys(RESET_BY_CALLER)]
    .filter((name) => !present.has(name));
  assert.deepEqual(phantom, [],
    `${phantom.length} exemption(s) name a function that no longer presses Tab. An exemption whose `
    + "subject is gone is debris, and it makes the table look like it covers more than it does:\n  "
    + phantom.join("\n  "));
});

test("#1205: a caller-side reset is REAL -- the named caller does it before the call", () => {
  for (const [walk, caller] of Object.entries(RESET_BY_CALLER)) {
    const body = functionBody(caller);
    const resetAt = body.indexOf("resetFocusToDocumentStart()");
    const callAt = body.indexOf(`${walk}(`);
    assert.ok(resetAt >= 0 && callAt >= 0 && resetAt < callAt,
      `${walk} is exempted as "reset by ${caller}", but ${caller} does not reset before calling it. `
      + "An exemption that points at a caller which does not do the thing is worse than no exemption");
  }
});
