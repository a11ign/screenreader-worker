/**
 * `graphicUnnamed` WAS A COUNT WITH NO IDENTITY, and an investigation stopped on it.
 *
 * `rules-real-pages` refused a verdict run with one new 1.1.1 finding — `graphicUnnamed=2` on
 * cqc.org.uk — and its own output says *"Read the evidence for each before doing anything else."* There
 * was no evidence to read. The capture recorded the NUMBER and nothing about the two nodes, so neither
 * the capture nor the live page could separate the rule's three causes: the tool is wrong, the page
 * changed, or the finding is right.
 *
 * The live page cannot answer it even in principle — these are sites their publishers keep editing, so
 * the page today is not the page captured. That is the rule's own second cause, and it makes the capture
 * the only admissible witness.
 *
 * **`ancestorName` is the field that decides the question this finding raises.** 1.1.1's Controls/Input
 * exception: *"If non-text content is a control or accepts user input, then it has a name that describes
 * its purpose."* An image inside a NAMED control conforms through that control's name, so counting it is
 * a false positive — and an exposed unnamed image in NO control is a real finding. Those need opposite
 * responses and the count could not tell them apart.
 *
 * Tested against a synthetic CDP tree because the real one needs a browser: the shape is what matters,
 * and `browser-session.mjs` cannot be imported into a test that runs anywhere (it drives a live page).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "browser-session.mjs"), "utf8");

/**
 * The three source pieces every reconstruction below needs: the role set, the per-ancestor folder, and the
 * walk itself. ONE extraction rather than a copy per test-harness function -- `nearestNamedAncestor` and
 * `recordUnnamedGraphic` both need all three in scope, and a second hand-written copy of these regexes is
 * exactly the "fact stated twice" shape this repo keeps paying for.
 */
function ancestorSource(): { roles: string; noteAncestor: string; nearestNamedAncestor: string } {
  const roles = /const CONTROL_ROLES = new Set\(\[([\s\S]*?)\]\);/.exec(SOURCE)?.[1];
  const noteAncestor = /function noteAncestor\(found, ancestor\) \{([\s\S]*?)\n\}/.exec(SOURCE)?.[1];
  const nearestNamedAncestor = /function nearestNamedAncestor\(node, byId\) \{([\s\S]*?)\n\}/.exec(SOURCE)?.[1];
  assert.ok(roles && noteAncestor && nearestNamedAncestor,
    "CONTROL_ROLES, noteAncestor or nearestNamedAncestor is gone from browser-session.mjs — this test "
    + "examines nothing");
  return { roles, noteAncestor, nearestNamedAncestor };
}

/**
 * The census runs inside `page.evaluate`, so the test rebuilds it from the source's own functions.
 *
 * `noteAncestor` is extracted alongside it and given its own name in scope, not inlined, because
 * `nearestNamedAncestor`'s source calls it BY NAME -- see `nearestNamedAncestor`'s own comment on why the
 * per-ancestor decision was split out (the complexity gate, not a second concept). `CONTROL_ROLES` is
 * needed one level further in: `noteAncestor` is what actually reads it.
 */
function nearestNamedAncestor(node: unknown, byId: Map<string, unknown>): Record<string, unknown> {
  const src = ancestorSource();
  return new Function("node", "byId", `
    const CONTROL_ROLES = new Set([${src.roles}]);
    function noteAncestor(found, ancestor) {${src.noteAncestor}}
    ${src.nearestNamedAncestor}
  `)(node, byId) as Record<string, unknown>;
}

const node = (id: string, role: string, name: string, parentId?: string) =>
  ({ nodeId: id, parentId, role: { value: role }, name: { value: name } });

test("an unnamed image inside a NAMED control reports that control", () => {
  // The Controls/Input exception, made readable. Before this the capture said "2" and the only way to ask
  // which two was to load a page that had moved on.
  const link = node("1", "link", "The Care Quality Commission");
  const img = node("2", "image", "", "1");
  const result = nearestNamedAncestor(img, new Map([["1", link]]));
  assert.equal(result.ancestorName, "The Care Quality Commission");
  assert.equal(result.ancestorRole, "link");
  assert.equal(result.role, "image");
});

test("an unnamed image in NO control says so, rather than saying nothing", () => {
  // The opposite verdict, and it must be distinguishable: an exposed unnamed image outside any control is
  // a REAL 1.1.1 finding — if decorative it should carry `aria-hidden`. `null` is the answer, never an
  // absent field, because absent and "no named ancestor" would read the same.
  const result = nearestNamedAncestor(node("2", "image", ""), new Map());
  assert.equal(result.ancestorName, null);
  assert.equal(result.ancestorRole, null);
  assert.equal(result.role, "image");
});

test("it walks PAST unnamed ancestors to the first named one", () => {
  // A real tree wraps an icon in spans and generic groups before reaching the button. Stopping at the
  // first ancestor would report `null` for the case the exception is about.
  const button = node("1", "button", "Search");
  const wrapper = node("2", "generic", "", "1");
  const img = node("3", "image", "", "2");
  const result = nearestNamedAncestor(img, new Map<string, unknown>([["1", button], ["2", wrapper]]));
  assert.equal(result.ancestorName, "Search");
  assert.equal(result.ancestorRole, "button");
});

test("a parent CYCLE terminates instead of hanging the capture", () => {
  // This runs inside a page evaluation with no timeout of its own, so `while (current)` on a malformed
  // tree would hang a capture rather than fail one — the 3.5-hour stall's shape, in a different place.
  const a = node("1", "generic", "", "2");
  const b = node("2", "generic", "", "1");
  const img = node("3", "image", "", "1");
  const result = nearestNamedAncestor(img, new Map<string, unknown>([["1", a], ["2", b]]));
  assert.equal(result.ancestorName, null);
});

test("the census carries the detail, bounded", () => {
  // A diagnostic on a page with hundreds of unnamed images must not become the cost of the capture.
  assert.match(SOURCE, /graphicUnnamedDetail/, "the census no longer records the detail");
  assert.match(SOURCE, /graphicUnnamedDetail\.length < \d+/,
    "the detail list is unbounded — an unbounded list of strings on every capture is how a diagnostic "
    + "becomes a cost");
});

/**
 * 1.1.1's CONTROLS/INPUT exception, enforced rather than documented.
 *
 * > "If non-text content is a control or accepts user input, then it has a NAME that describes its
 * > purpose."
 *
 * An image inside a NAMED control satisfies 1.1.1 through that control's name — `name` is defined as
 * "text by which software can identify a component within web content to the user", which the image need
 * not carry itself. Counting it is a false positive, and it WAS one twice: `rules-real-pages` refused two
 * verdict runs on `1.1.1 cqc.org.uk`, and the capture's own detail showed both nameless images inside a
 * link named "The Care Quality Commission" — the site logo, marked up exactly as it should be.
 */
function recordUnnamedGraphic(census: Record<string, unknown>, node: unknown, byId: Map<string, unknown>) {
  const body = /function recordUnnamedGraphic\(census, node, byId\) \{([\s\S]*?)\n\}/.exec(SOURCE)?.[1];
  assert.ok(body, "recordUnnamedGraphic is gone — this test examines nothing");
  const src = ancestorSource();
  new Function("census", "node", "byId", `
    const CONTROL_ROLES = new Set([${src.roles}]);
    function noteAncestor(found, ancestor) {${src.noteAncestor}}
    function nearestNamedAncestor(node, byId) {${src.nearestNamedAncestor}}
    ${body}
  `)(census, node, byId);
}

const fresh = () => ({
  graphicUnnamed: 0, graphicUnnamedDetail: [] as unknown[],
  graphicExempted: 0, graphicExemptedDetail: [] as unknown[],
});

test("an image inside a NAMED CONTROL is not counted — the Controls/Input exception", () => {
  const census = fresh();
  const link = node("1", "link", "The Care Quality Commission");
  recordUnnamedGraphic(census, node("2", "image", "", "1"), new Map([["1", link]]));
  assert.equal(census.graphicUnnamed, 0,
    "an image inside a named link conforms through that link's name; counting it accused cqc.org.uk twice");
  assert.deepEqual(census.graphicUnnamedDetail, [], "and it is not listed as a finding either");
  // THE EXEMPTED POPULATION, MADE VISIBLE — this is the one case this file could never see before: an
  // image that IS correctly exempted used to leave no record at all.
  assert.equal(census.graphicExempted, 1);
  assert.deepEqual(census.graphicExemptedDetail,
    [{ role: "image", ancestorName: "The Care Quality Commission", ancestorRole: "link",
      controlRole: "link", controlName: "The Care Quality Commission" }]);
});

test("an image inside a named NON-control is still counted", () => {
  // NOT a blanket ancestor test. The exception says "is a CONTROL or accepts user input" — a named
  // `region` or `figure` wrapping a nameless image leaves the image unidentifiable, which IS the finding.
  const census = fresh();
  const region = node("1", "region", "Latest news");
  recordUnnamedGraphic(census, node("2", "image", "", "1"), new Map([["1", region]]));
  assert.equal(census.graphicUnnamed, 1,
    "a named region does not discharge 1.1.1 — only a control's name does");
  assert.equal(census.graphicExempted, 0);
});

test("an image in NO control is still counted, with its detail", () => {
  const census = fresh();
  recordUnnamedGraphic(census, node("2", "image", ""), new Map());
  assert.equal(census.graphicUnnamed, 1);
  assert.deepEqual(census.graphicUnnamedDetail,
    [{ role: "image", ancestorName: null, ancestorRole: null, controlRole: null, controlName: null }]);
});

test("A NAMED NON-CONTROL WRAPPER MUST NOT STOP THE SEARCH FOR A CONTROL FURTHER OUT", () => {
  // THE DEFECT `docs/backlog.md` NAMED, reproduced directly: a real tree wraps an icon in a `<div
  // aria-label="...">` unrelated to the image (a component library adds one routinely) before reaching a
  // genuinely named control. The OLD walk stopped at the wrapper -- the first NAMED ancestor -- and failed
  // the control-role test against a node that was never the control the exception asks about, so a
  // CONFORMING image (a named control sits one level further out) was counted as a 1.1.1 finding.
  const census = fresh();
  const button = node("1", "button", "Search");
  const wrapper = node("2", "generic", "Photo credit: Jane Doe", "1");
  const img = node("3", "image", "", "2");
  recordUnnamedGraphic(census, img, new Map<string, unknown>([["1", button], ["2", wrapper]]));
  assert.equal(census.graphicUnnamed, 0,
    "the image is content of the named button one level further out; the wrapper's own unrelated name "
    + "must not end the search before the walk reaches it");
  assert.equal(census.graphicExempted, 1);
  assert.deepEqual(census.graphicExemptedDetail,
    // `ancestorName`/`ancestorRole` still report the NEAREST named ancestor (the wrapper) for the general
    // diagnostic; `controlRole`/`controlName` report the control the exemption actually turned on. Both
    // survive in the record, because a human reading this later benefits from seeing both facts, not just
    // the one that decided the verdict.
    [{ role: "image", ancestorName: "Photo credit: Jane Doe", ancestorRole: "generic",
      controlRole: "button", controlName: "Search" }]);
});

test("a control ancestor that is itself UNNAMED does not exempt, and does not stop the search either", () => {
  // The mirror case: the nearest control has no name of its own. This must not exempt (an unnamed
  // control's role cannot discharge the requirement for a control that ISN'T named), and it correctly
  // does not chase a MORE distant control either -- see `nearestNamedAncestor`'s own comment on why an
  // image belongs to the control it is nearest to, not to a farther, unrelated one.
  const census = fresh();
  const unnamedButton = node("1", "button", "");
  const img = node("2", "image", "", "1");
  recordUnnamedGraphic(census, img, new Map<string, unknown>([["1", unnamedButton]]));
  assert.equal(census.graphicUnnamed, 1, "an unnamed control's role cannot discharge the requirement");
  assert.equal(census.graphicExempted, 0);
});

test("a node with no id cannot ADOPT an image that has no parent", () => {
  // `String(undefined)` is the string "undefined", so a map keyed without a guard puts every id-less node
  // under one key and an image with no `parentId` then "finds" whichever landed there last. That made a
  // nameless image the child of a named link in the census fixture, fired the Controls/Input exception,
  // and took the count to zero — a false NEGATIVE introduced by the fix for a false positive.
  //
  // Absent read as a value, which is this repo's oldest defect, committed while enforcing an exception
  // whose whole point is telling two absences apart.
  const orphan = { nodeId: undefined, role: { value: "image" }, name: { value: "" } };
  const namedLink = { nodeId: undefined, role: { value: "link" }, name: { value: "Home" } };
  const census = fresh();
  // Built the way the census builds it, so the guard is exercised rather than described.
  const byId = new Map<string, unknown>(
    [orphan, namedLink].filter((n) => n.nodeId != null).map((n) => [String(n.nodeId), n]));
  recordUnnamedGraphic(census, orphan, byId);
  assert.equal(census.graphicUnnamed, 1,
    "an image with no parent must stay a finding — it was not adopted by the id-less link");
});
