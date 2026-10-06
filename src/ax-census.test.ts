/**
 * The completeness oracle.
 *
 * `structure.landmarks` is swept with quick navigation, which cannot reach a landmark containing the
 * caret — so a `<main>` wrapping the page is invisible, on 2,063 of 2,064 corpus captures. An
 * under-reporting sweep is indistinguishable from a page that exposes nothing, and nothing could see it.
 *
 * Asking Chromium over the already-open DevTools socket costs milliseconds. Asking NVDA's own Elements
 * List costs ~11s per capture, because every keystroke waits on guidepup's 1s speech-quiet debounce —
 * the difference between a check you run on every capture and one you can never afford.
 *
 * This census is an ORACLE, never evidence: what the screen reader announced remains the evidence, and
 * the accessibility tree is explicitly barred from being a model feature.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { censusFromAXTree, truncatedAnnouncements } from "./browser-session.mjs";

// A real element always has a backing DOM node, and the census now requires one: a node WITHOUT
// `backendDOMNodeId` is CSS-generated content, which the oracle must not count. `generated()` below is the
// other side of that rule. Any positive id will do — the census only asks whether the field is present.
const DOM_BACKED = 42;

const node = (role: string, name?: string, ignored = false) => ({
  role: { value: role }, name: name === undefined ? undefined : { value: name }, ignored,
  backendDOMNodeId: DOM_BACKED,
});

/**
 * A CSS-generated AX node, in the exact shape captured from the live W3C BAD "after" page.
 *
 * Chromium exposes a `list-style-image` bullet as role=image with a NEGATIVE synthetic nodeId, empty
 * properties and no `backendDOMNodeId`, parented to a `<::marker>` pseudo-element. Nothing about it is
 * reachable by quick navigation, and it has no text alternative because a bullet does not need one.
 */
const generated = (role: string, name = "") => ({
  // `nodeId` is kept for fidelity to the captured shape; the census never reads it. The ABSENT
  // `backendDOMNodeId` is what this fixture is really about.
  nodeId: "-1000000035", role: { value: role }, name: { value: name }, ignored: false, properties: [],
});

test("counts the landmark roles a screen reader would announce", () => {
  const census = censusFromAXTree([
    node("main"), node("navigation", "Support links"), node("banner"), node("contentinfo"),
    node("complementary"), node("search"), node("form", "Hire duration"),
  ]);
  assert.equal(census.landmark, 7);
});

test("an UNNAMED region is not a landmark", () => {
  // ARIA requires an accessible name for role="region" to be exposed as a landmark, and NVDA agrees:
  // named regions are announced ("Latest news, region") while a bare <section> is not. Counting them
  // would make the oracle demand landmarks the page does not have, and a guard that cries wolf is
  // removed rather than heeded.
  assert.equal(censusFromAXTree([node("region")]).landmark, 0);
  assert.equal(censusFromAXTree([node("region", "")]).landmark, 0);
  assert.equal(censusFromAXTree([node("region", "Latest news")]).landmark, 1);
});

test("ignored nodes are not counted", () => {
  // A node the accessibility tree ignores is one NVDA can never announce, so requiring it would create
  // a disagreement no capture could ever satisfy.
  assert.equal(censusFromAXTree([node("main", undefined, true)]).landmark, 0);
  assert.equal(censusFromAXTree([node("heading", "Title", true)]).heading, 0);
});

test("the case that started this: a main wrapping the page IS exposed", () => {
  // The sweep reports [] here and the page really does have a landmark. That gap is the whole point.
  const census = censusFromAXTree([node("main"), node("heading", "Cycling guide"), node("heading", "Route safety")]);
  assert.equal(census.landmark, 1);
  assert.equal(census.heading, 2);
});

test("headings, links and graphics are counted for the other sweeps", () => {
  const census = censusFromAXTree([
    node("heading", "A"), node("link", "Read more"), node("image", "A chart"), node("img", "Another"),
  ]);
  assert.deepEqual(census, {
    landmark: 0, heading: 1, link: 1, graphicUnnamed: 0, graphic: 2, formControl: 0,
    // Names are kept alongside the counts so a TRUNCATED announcement is detectable; a count
    // cross-check cannot see a control that is present but misnamed.
    names: ["A", "Read more", "A chart", "Another"],
    // WHAT `graphicUnnamed` COUNTED, added 2026-09-04. Empty here because every graphic is named — and
    // these two assertions are `deepEqual` on the WHOLE census precisely so a new field cannot appear
    // unnoticed, which is what the census's own comment warns about: "an assertion on named fields cannot
    // see a field that was ADDED".
    graphicUnnamedDetail: [],
    // THE EXEMPTED SIBLING, added 2026-09-06 — see `census-detail.test.ts` for why an exempted image
    // needed a record at all. Empty here for the same reason `graphicUnnamedDetail` is: nothing in this
    // fixture is an unnamed graphic in the first place.
    graphicExempted: 0, graphicExemptedDetail: [],
    // Every name here is unique, so distinct == raw. The case that matters is the next test.
    distinct: { landmark: 0, heading: 1, link: 1, graphic: 2, formControl: 0 },
  });
});

test("a malformed or empty tree yields zeros, not a throw", () => {
  // The oracle must never be the reason a capture fails.
  const empty = { landmark: 0, heading: 0, link: 0, graphicUnnamed: 0, graphic: 0, formControl: 0,
    names: [], graphicUnnamedDetail: [], graphicExempted: 0, graphicExemptedDetail: [],
    distinct: { landmark: 0, heading: 0, link: 0, graphic: 0, formControl: 0 } };
  assert.deepEqual(censusFromAXTree([]), empty);
  assert.deepEqual(censusFromAXTree(undefined), empty);
  assert.deepEqual(censusFromAXTree([null, {}]), empty);
});

/**
 * Detecting a TRUNCATED announcement.
 *
 * Under guidepup's default `capture: "initial"` a log entry holds only the phrases that arrived before
 * the first one resolved the promise, so a fragment can be recorded as the whole announcement. Measured
 * once in 48 captures: a button announced as `"o, button"` instead of `"Open account search, button"`.
 *
 * `{capture: true}` prevents it by waiting the full 1s debounce per keystroke — and costs 3x (19-20s per
 * capture becomes 58-60s, ~12h for a corpus run instead of ~2h). Detecting it against the page's real
 * accessible names costs nothing, because the tree is already fetched.
 *
 * A count cross-check cannot see this: the sweep finds the right NUMBER of controls, one of them
 * misnamed.
 */
test("names cover roles the COUNTS do not, or the detector cannot see its own case", () => {
  // `button` is not a counted role -- the sweeps compare headings, landmarks, links and graphics. But the
  // truncation this detects was a BUTTON ("o" for "Open account search"), so restricting names to counted
  // roles left the real name absent and the detector blind to the only case it exists for. Verified on a
  // guest before this was fixed: names came back as ["Account search"], the h1, with no button name.
  const census = censusFromAXTree([
    node("heading", "Account search"), node("button", "Open account search"),
    node("textbox", "Hire duration"),
  ]);
  assert.equal(census.heading, 1);
  assert.deepEqual(census.names, ["Account search", "Open account search", "Hire duration"]);
  assert.equal(truncatedAnnouncements(["o, button"], census.names).length, 1,
    "the button truncation must be detectable");
});

test("a name that stops short of a real accessible name is flagged", () => {
  const found = truncatedAnnouncements(["o, button"], ["Open account search", "Account search"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].heard, "o, button");
  assert.equal(found[0].name, "open account search");
});

test("a complete announcement is not flagged", () => {
  assert.deepEqual(truncatedAnnouncements(["Open account search, button"], ["Open account search"]), []);
});

test("a control genuinely named with a short string is not flagged", () => {
  // An exact match is fine however short. Flagging it would punish a page for a terse but real label,
  // and a check that cries wolf gets switched off.
  assert.deepEqual(truncatedAnnouncements(["o, button"], ["o"]), []);
  assert.deepEqual(truncatedAnnouncements(["OK, button"], ["OK", "OK to continue"]), []);
});

test("an unrelated announcement is not flagged", () => {
  assert.deepEqual(truncatedAnnouncements(["Submit, button"], ["Open account search"]), []);
});

test("nothing to compare against yields nothing", () => {
  assert.deepEqual(truncatedAnnouncements(["o, button"], []), []);
  assert.deepEqual(truncatedAnnouncements(undefined as never, undefined), []);
});

test("an image with no accessible name is counted separately, and a decorative one is not", () => {
  // This is a 1.1.1 finding the announcements cannot always reach. NVDA's quick navigation walks past a
  // wholly nameless graphic: where an image has a filename it says "Unlabeled graphic" and the sweep
  // records it, but an `<img>` with no alt and a `data:` URI has nothing to announce. Measured on the eval
  // fixtures — tree 2 graphics / sweep 1, tree 1 / sweep 0, tree 3 / sweep 2.
  //
  // The `ignored` case is what makes the counter safe to act on: Chromium marks a decorative `alt=""`
  // image as ignored, so it must never reach the count. Without that, every well-authored decorative image
  // on the web would become a false 1.1.1.
  const census = censusFromAXTree([
    node("image", "Acme Widgets company logo"), node("image", ""), node("img"),
    node("img", "", true),
  ]);
  assert.equal(census.graphic, 3, "the decorative ignored image is not a graphic the user meets");
  assert.equal(census.graphicUnnamed, 2, "two of the three expose no name at all");
});

test("a CSS list bullet is not an image missing its text alternative", () => {
  // The false-positive this guard exists for, in the shape measured on the live page. The W3C BAD "after"
  // pages set `list-style-image`, Chromium exposes each bullet as an unnamed role=image node, and the
  // census counted two of them — which `addUnnamedGraphics` turns into a 1.1.1 accusation against markup
  // W3C publishes as fully WCAG 2.0 AA conformant. A bullet has no text alternative because it needs none.
  //
  // Note what this was NOT: the page's four decorative `alt=""` images were ignored by Chromium correctly
  // the whole time. 6 real images plus 2 bullets is the 8 the census reported.
  const census = censusFromAXTree([
    node("image", "W3C logo"), node("image", "Web Accessibility Initiative (WAI) logo"),
    generated("image"), generated("image"),
  ]);
  assert.equal(census.graphic, 2, "the bullets are not graphics the user meets");
  assert.equal(census.graphicUnnamed, 0,
    "a conformant page must produce NO unnamed graphics — this is an accusation, not a metric");
});

test("a real image with no name is STILL counted, so the guard cannot hide a finding", () => {
  // The mirror image, and the one that matters more: a guard that silenced real 1.1.1 failures would be
  // worse than the false positive it fixes. Measured on the BAD "before" page — the published inaccessible
  // demo — all 33 unnamed images carry a `backendDOMNodeId`, so none of them is excluded.
  const census = censusFromAXTree([
    node("image", ""), node("img"), generated("image"),
  ]);
  assert.equal(census.graphicUnnamed, 2, "both DOM-backed nameless images remain findings");
});

test("generated content still contributes its NAME, because NVDA announces generated text", () => {
  // Excluded from the COUNTS, not from the names. `::before { content: "New!" }` is spoken, so dropping it
  // from `names` would blind the truncation detector to a phrase a capture can legitimately contain.
  const census = censusFromAXTree([generated("image", "New!")]);
  assert.equal(census.graphic, 0, "still not a counted graphic");
  assert.deepEqual(census.names, ["New!"], "but the name a screen reader can speak is kept");
});

test("DISTINCT NAMES, NOT ELEMENTS — the count the sweep can actually be compared against", () => {
  // The reason this field exists. `collectPhrase` DEDUPES: an announcement already heard is dropped, so
  // `structure.links` is a list of distinct announcements while the element count counts elements.
  //
  // Measured 2026-08-29 across 106 real captures: 75% of named elements share a name with another, and
  // 100% of pages carry at least one duplicate — ico.org.uk has 15,081 duplicates among 15,356 names.
  // Comparing a deduplicated sweep against a raw element count reported a disagreement on 97% of pages,
  // about half of it definitional.
  const census = censusFromAXTree([
    node("link", "Read more"), node("link", "Read more"), node("link", "Read more"),
    node("link", "Contact us"), node("heading", "News"),
  ]);
  assert.equal(census.link, 4, "four link ELEMENTS are present");
  assert.equal(census.distinct.link, 2, "a sweep can only announce two DISTINCT link names");
  assert.equal(census.distinct.heading, 1);
});

test("an UNNAMED element counts once per element, never collapsed", () => {
  // Unnamed elements have no name to be distinct from, and the sweep still announces each one. Collapsing
  // them would under-count exactly what 1.1.1 and 4.1.2 are about — an unnamed control is the finding.
  const census = censusFromAXTree([node("image", ""), node("image", ""), node("link", "Home")]);
  assert.equal(census.graphic, 2);
  assert.equal(census.distinct.graphic, 2, "two unnamed graphics are two things, not one");
  assert.equal(census.graphicUnnamed, 2);
});

test("FORM CONTROLS ARE COUNTED IN NVDA'S ALPHABET, which is not the DOM's", () => {
  // `dom.formField` counts `input, select, textarea, [role=textbox], [role=combobox]` and is 2.1.2's
  // denominator. NVDA's `f` quick-nav ALSO walks buttons, checkboxes, radios and sliders — so comparing
  // `structure.formFields` against the DOM count would report a phantom on every page with a button.
  // Two alphabets compared as one is the defect `capture-integrity-plan` is about.
  const census = censusFromAXTree([
    node("textbox", "Search"), node("button", "Go"), node("checkbox", "Remember me"),
    node("radio", "Card"), node("combobox", "Country"), node("slider", "Volume"),
  ]);
  assert.equal(census.distinct.formControl, 6,
    "a button is a form field to NVDA even though it is not one to the DOM census");
  // THE WHOLE OBJECT, and NO NaN ANYWHERE. Asserting only `distinct.formControl` is what let a real
  // defect ship: `census[bucket] += 1` had no top-level `formControl`, so it was `undefined + 1` = NaN,
  // which JSON writes as `null`. A per-field assertion cannot see a field that was added, and cannot see
  // one that is quietly NaN — the failure was found on a live capture instead.
  assert.equal(census.formControl, 6, "the top-level element count must exist for every bucket");
  for (const [field, value] of Object.entries(census)) {
    assert.ok(!(typeof value === "number" && Number.isNaN(value)),
      `census.${field} is NaN — a bucket was added to ROLE_BUCKET without a counter to increment`);
  }
});

test("a form control with NO NAME still counts, because an unnamed control is the 4.1.2 finding", () => {
  // The rule this repo paid most for: a check must never reject evidence whose absence IS the finding.
  const census = censusFromAXTree([node("button", ""), node("button", "")]);
  assert.equal(census.distinct.formControl, 2, "two unnamed buttons are two controls, not one");
});
