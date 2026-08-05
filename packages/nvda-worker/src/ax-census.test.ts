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

const node = (role: string, name?: string, ignored = false) => ({
  role: { value: role }, name: name === undefined ? undefined : { value: name }, ignored,
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
    landmark: 0, heading: 1, link: 1, graphicUnnamed: 0, graphic: 2,
    // Names are kept alongside the counts so a TRUNCATED announcement is detectable; a count
    // cross-check cannot see a control that is present but misnamed.
    names: ["A", "Read more", "A chart", "Another"],
  });
});

test("a malformed or empty tree yields zeros, not a throw", () => {
  // The oracle must never be the reason a capture fails.
  const empty = { landmark: 0, heading: 0, link: 0, graphicUnnamed: 0, graphic: 0, names: [] };
  assert.deepEqual(censusFromAXTree([]), empty);
  assert.deepEqual(censusFromAXTree(undefined as never), empty);
  assert.deepEqual(censusFromAXTree([null, {}] as never), empty);
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
    { role: { value: "heading" }, name: { value: "Account search" } },
    { role: { value: "button" }, name: { value: "Open account search" } },
    { role: { value: "textbox" }, name: { value: "Hire duration" } },
  ] as never);
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
  assert.deepEqual(truncatedAnnouncements(undefined as never, undefined as never), []);
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
    { role: { value: "image" }, name: { value: "Acme Widgets company logo" } },
    { role: { value: "image" }, name: { value: "" } },
    { role: { value: "img" } },
    { role: { value: "img" }, ignored: true, name: { value: "" } },
  ]);
  assert.equal(census.graphic, 3, "the decorative ignored image is not a graphic the user meets");
  assert.equal(census.graphicUnnamed, 2, "two of the three expose no name at all");
});
