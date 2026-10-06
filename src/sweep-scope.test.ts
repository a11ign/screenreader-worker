/**
 * THE SCOPE IS READ BEFORE THE SWEEP AND LANDS ON THE SWEEP'S OWN MARK — #897.
 *
 * `markPageState` already fingerprints the document before each sweep (#758). This returns what it read
 * so `collectByType` can put the scope on the `sweep` mark itself, rather than leaving a verdict and the
 * scope it is about on two marks — #863's finding, where a tab walk's document lived on a separate mark
 * and the two were joined only by ordering.
 *
 * READ FROM SOURCE — the `activation-gates.test.ts` exemption: this package imports guidepup and throws
 * at module load where no screen reader exists, so nothing here can call `collectByType`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROBES = readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8");

const bodyOf = (declaration: string) => {
  const at = PROBES.indexOf(declaration);
  assert.notEqual(at, -1, `${declaration} — the function this test is about no longer exists`);
  const from = PROBES.slice(at);
  return from.slice(0, from.indexOf("\n}\n"));
};

test("the scope is read BEFORE either direction walks", () => {
  // After the walk it would name wherever the sweep ended up — which for the sweep that ENTERS a dialog
  // is a different answer from the one that describes what it examined. Same ordering argument as
  // `censusBeforeNavigating`, and as `walkedUrl` in the tab walk.
  const body = bodyOf("async function collectByType(commands, ctx) {");
  const read = body.indexOf("markPageState(`sweep:${ctx.label}`");
  const walks = body.indexOf("sweepInDirection(commands.prev");
  assert.ok(read >= 0, "collectByType must fingerprint the document before walking it");
  assert.ok(read < walks, "the scope must be read before the first direction walks");
});

test("it costs NO extra round trip — the same read that already happened", () => {
  // A per-sweep NVDA query would be ~2 trips × 8 sweeps on a phase that is already the largest on a real
  // page (#397). `markPageState` returns the census it had already fetched, so this adds none.
  const mark = bodyOf("async function markPageState(beforeProbe, diag) {");
  assert.match(mark, /return dom;/,
    "markPageState must return what it read, so its caller needs no second census");
  const body = bodyOf("async function collectByType(commands, ctx) {");
  assert.equal((body.match(/domCensus\(|markPageState\(/g) ?? []).length, 1,
    "exactly one census read per sweep — a second would double the fingerprint's cost");
});

test("the sweep mark carries the scope, not just the adjacent pageState mark", () => {
  const body = bodyOf("async function collectByType(commands, ctx) {");
  assert.match(body, /scope: scopeAt \? \{ openDialog: scopeAt\.openDialog \?\? null \} : undefined/,
    "a reader of `sweep` must not have to know `pageState` exists to know what was examined");
});

test("`undefined` and `null` stay different answers all the way to the mark", () => {
  // "The census failed" and "there was no modal" are different facts. Collapsing them is the shape this
  // project pays most for — an absent measurement read as the measurement zero.
  const body = bodyOf("async function collectByType(commands, ctx) {");
  assert.match(body, /scopeAt \?/,
    "a census that could not be read must leave the scope absent, never report `no dialog`");
});

test("the census reports the dialog's NAME, and only a MODAL one", () => {
  const session = readFileSync(resolve(import.meta.dirname, "browser-session.mjs"), "utf8");
  const expression = /const DOM_CENSUS_EXPRESSION = `([\s\S]*?)`;/.exec(session);
  assert.ok(expression, "the census expression must be findable by name");
  assert.match(expression[1], /aria-modal='true'/,
    "a non-modal dialog does not seal quick navigation, and reporting one would mark sweeps that were "
    + "never confined");
  assert.match(expression[1], /matches\(":modal"\)/,
    "a native `<dialog open>` is not `showModal()`; only the second is inert-backed");
  // A STRING, never a count: `censusElementCounts` builds the element counts from every numeric field on
  // a census mark except two, so a numeric count field would arrive downstream as an element type.
  //
  // The DEFINITION form (`name:`), not the bare word — the expression's own comment explains why a count
  // is wrong, and a bare-word assertion would be failed by the explanation. That is this repo's
  // "a fixture cannot name itself": a check whose subject appears in the prose about it.
  assert.doesNotMatch(expression[1], /^\s*openDialog(Count|s)\s*:/m,
    "no numeric sibling of `openDialog` — a count on a census mark becomes an element type downstream");
});
