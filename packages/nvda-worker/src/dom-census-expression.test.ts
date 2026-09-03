/**
 * The DOM census runs INSIDE the page, so nothing else can check it.
 *
 * `domCensus()` sends a string to `Runtime.evaluate`. That string is never parsed by tsc, never seen by
 * ESLint, and never imported — so a typo in it fails at runtime, on a worker, mid-capture, as a `null`
 * census that reads exactly like a page which exposes nothing. This repo has a rule for precisely that
 * class: for `.mjs`, `node -e "import(...)"` is the only real check. Page-side JS is one level worse
 * again, and this is its equivalent — extract the expression and run it against a synthetic DOM.
 *
 * ## What it is asserting
 *
 * `graphicUnnamed` was a COUNT. Settling whether cqc.org.uk's two unnamed graphics were real meant
 * fetching the page by hand and counting `<svg>` elements without a `<title>` — and this repo's own rule
 * is that a count is where an investigation stops rather than starts.
 *
 * The identification is DOM-side because an unnamed node has, by definition, no name to identify it by.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(fileURLToPath(new URL("./browser-session.mjs", import.meta.url)), "utf8");

/** The expression as the page will receive it, with the template escapes undone. */
function pageExpression(): string {
  // Named, because this file shares its module with `mediaCensus`, which has an expression of its own.
  // A regex for "the const named EXPRESSION" matched whichever came first, so extracting the census to
  // module level silently pointed this test at the wrong program — it kept passing having examined
  // something else. Reading a NAME is the difference between a fixture and a coincidence.
  const match = SOURCE.match(/const DOM_CENSUS_EXPRESSION = `([\s\S]*?)`;/);
  assert.ok(match, "the census expression must be findable BY NAME, or this test examines nothing");
  return match[1].replace(/\\`/g, "`").replace(/\\\$/g, "$");
}

type El = Record<string, unknown>;

/**
 * @param opts `rendered: false` makes `checkVisibility()` say no — a closed mega-menu, markup the page
 *   HAS that Tab cannot reach. `inert: true` puts the element inside an `[inert]` subtree, which renders
 *   normally and takes no focus: the modal-dialog pattern, and the one `checkVisibility` cannot answer.
 */
function element(
  tag: string, attrs: Record<string, string>, titleText?: string,
  opts: { rendered?: boolean; inert?: boolean } = {},
): El {
  return {
    tagName: tag.toUpperCase(),
    getAttribute: (k: string) => attrs[k] ?? null,
    closest: (selector: string) => (opts.inert && selector === "[inert]" ? {} : null),
    hasAttribute: (k: string) => k in attrs,
    checkVisibility: () => opts.rendered !== false,
    querySelector: () => (titleText ? { textContent: titleText } : null),
  };
}

/** An element from a browser too old to have `checkVisibility` — the expression must still count it. */
function elementWithoutVisibilityApi(tag: string, attrs: Record<string, string>): El {
  const el = element(tag, attrs);
  delete el.checkVisibility;
  return el;
}

/**
 * @param graphics what an `img, svg…` selector returns
 * @param tabbable what the `a[href], button…` selector returns — the tab-stop census
 *
 * Two selectors, because the expression asks two questions of the page and a harness serving only one
 * lets the other return `[]` and assert nothing. That is how `tabbable` could have been added, tested,
 * and never once executed.
 */
function runAgainst(
  graphics: El[], tabbable: El[] = [],
  lang: { documentLang?: string; parts?: El[] } = {},
): Record<string, unknown> {
  // `documentElement` is a real object here, not a stub returning nothing, because the census compares
  // AGAINST it: a `[lang]` on <html> is the document's language, not a part's, and a harness where the
  // comparison can never be true would let that filter be wrong and assert nothing.
  const documentElement = {
    getAttribute: () => lang.documentLang ?? null,
    closest: () => null,
  } as unknown as El;
  const document = {
    documentElement,
    querySelectorAll: (selector: string) => {
      if (selector.startsWith("img")) return graphics;
      if (selector.startsWith("a[href]")) return tabbable;
      if (selector === "[lang]") return lang.parts ?? [];
      return [];
    },
  };
  return new Function("document", `return ${pageExpression()}`)(document);
}

test("an image with no accessible name is NAMED in the census, not merely counted", () => {
  const out = runAgainst([
    element("img", { src: "/assets/logo.png?v=2", class: "brand wide" }),
    element("img", { src: "/assets/hero.png", alt: "A hero image" }),
  ]);
  assert.equal(out.unnamedGraphicCount, 1);
  assert.deepEqual(out.unnamedGraphics, ["img logo.png .brand"],
    "the identifier must be enough to find the element on the page — the filename and first class");
});

test("an svg named only by a child <title> is NOT reported", () => {
  // The exact shape that settled cqc.org.uk: 18 svgs, 17 exposed, only 14 carrying a <title>.
  const out = runAgainst([
    element("svg", { class: "icon icon--hospital" }),
    element("svg", { class: "icon icon--search" }, "Search"),
  ]);
  assert.equal(out.unnamedGraphicCount, 1);
  assert.deepEqual(out.unnamedGraphics, ["svg .icon"]);
});

test("a decorative alt=\"\" image is not a graphic at all", () => {
  // Chromium marks it ignored and the AX census does not count it, so counting it here would invent a
  // disagreement on a correct page — the false-accusation shape the census guards already exist for.
  const out = runAgainst([element("img", { alt: "" }), element("img", { alt: "Real" })]);
  assert.equal(out.graphic, 1);
  assert.equal(out.unnamedGraphicCount, 0);
});

test("aria-label and title count as names, without resolving aria-labelledby", () => {
  // Presence, not resolution. Following the reference is the accessibility tree's job and Chromium has
  // already done it; this list exists to point a human at an element, not to second-guess the tree.
  const out = runAgainst([
    element("img", { src: "a.png", "aria-label": "Labelled" }),
    element("img", { src: "b.png", title: "Titled" }),
    element("img", { src: "c.png", "aria-labelledby": "some-id" }),
    element("img", { src: "d.png" }),
  ]);
  assert.equal(out.unnamedGraphicCount, 1);
  assert.deepEqual(out.unnamedGraphics, ["img d.png"]);
});

test("the list is CAPPED and the count is not", () => {
  // A truncated list that reads as complete is the defect one layer along, so the full count travels
  // beside the sample rather than being inferred from its length.
  const many = Array.from({ length: 9 }, (_, i) => element("img", { src: `x${i}.png` }));
  const out = runAgainst(many);
  assert.equal((out.unnamedGraphics as string[]).length, 5);
  assert.equal(out.unnamedGraphicCount, 9,
    "the count must survive the cap, or a page with 200 unnamed images reports 5");
});

test("tabbable counts what TAB can reach, which is why it is asked of the DOM and not the sweep", () => {
  // THE CASE THIS COUNT EXISTS FOR. `vague-link-inert` is an anchor with `tabindex="-1"` — a real corpus
  // defect, walked by NVDA's link quick-nav and therefore present in `structure.links`, and NOT a tab
  // stop. Counting swept links as the denominator for "did focus reach everything" would fire 2.1.2 on
  // every page carrying one. The DOM knows the difference and the sweep cannot.
  const out = runAgainst([], [
    element("a", { href: "/news" }),
    element("a", { href: "#detail-note", tabindex: "-1" }),
    element("input", { name: "q" }),
  ]);
  assert.equal(out.tabbable, 2, "the inert anchor is announced but is not a tab stop");
});

test("a hidden control is not a tab stop", () => {
  // Reporting a control the browser skips as one focus failed to reach is this project's oldest defect:
  // a limit of the page read as a finding about it.
  const out = runAgainst([], [
    element("a", { href: "/news" }),
    element("button", { hidden: "" }),
  ]);
  assert.equal(out.tabbable, 1);
});

test("a page with no tab stops reports 0, which is a reading and not a silence", () => {
  // 0 and absent must stay distinguishable: a capture predating this field reports `undefined`, which the
  // rule reads as "cannot say". A page that genuinely has no controls reports 0.
  assert.equal(runAgainst([], []).tabbable, 0);
});

test("a control in a CLOSED mega-menu is not a tab stop, so it is not in the denominator", () => {
  // The false positive this filter exists to prevent. Without it a conformant page whose nav is collapsed
  // reports a tab ring far smaller than its markup, and 2.1.2 reads that as focus never escaping — a
  // limit of the measurement reported as a finding about the page, this project's oldest defect.
  const census = runAgainst([], [
    element("a", { href: "/orders" }),
    element("a", { href: "/hidden-1" }, undefined, { rendered: false }),
    element("a", { href: "/hidden-2" }, undefined, { rendered: false }),
  ]);
  assert.equal(census.tabbable, 1);
});

test("a control sealed behind an [inert] dialog is not a tab stop", () => {
  // `checkVisibility` returns TRUE for an inert subtree — it renders, it just takes no focus. So this is
  // a separate check, and it is the modal pattern exactly: a 2.1.2 denominator that ignored `inert` would
  // count the very background a conformant dialog seals off, and then blame the dialog for sealing it.
  const census = runAgainst([], [
    element("button", {}, undefined, { inert: true }),
    element("input", {}, undefined, { inert: true }),
    element("button", {}),
  ]);
  assert.equal(census.tabbable, 1);
});

test("a browser without checkVisibility still counts its controls, rather than reporting none", () => {
  // The guard is `typeof !== "function"`, so an older engine degrades to the previous behaviour. Treating
  // a missing API as "nothing is visible" would make `tabbable` zero and silently retire the rule reading
  // it — the difference between "cannot say" and "none", which the whole census exists to preserve.
  const census = runAgainst([], [
    elementWithoutVisibilityApi("a", { href: "/a" }),
    elementWithoutVisibilityApi("button", {}),
  ]);
  assert.equal(census.tabbable, 2);
});


// --- 3.1.2 Language of Parts. Added 2026-09-03, and the existing harness refused the change until the
// --- stub could actually answer the questions the census now asks.

/**
 * An element carrying a `lang`, with the `closest` the census filters on.
 *
 * `closest` is not optional decoration: `all()` filters through `visible`, which is
 * `!el.closest("[aria-hidden='true']")`. The first version of this stub had only `getAttribute` and every
 * lang test threw inside the expression — the harness refusing an element that could not answer what the
 * census asks, which is the same reason the file's own comment gives for serving two selectors.
 */
const langEl = (value: string | null): El => ({
  getAttribute: (name: string) => (name === "lang" ? value : null),
  closest: () => null,
}) as unknown as El;

test("the DOCUMENT language and the PARTS are separate answers", () => {
  // 3.1.1 asks whether the document declares a language at all; 3.1.2 asks whether passages that DIFFER
  // from it say so. The second is only answerable against the first, so they are never one field.
  const out = runAgainst([], [], { documentLang: "en", parts: [langEl("fr"), langEl("de")] });
  assert.equal(out.documentLang, "en");
  assert.deepEqual(out.partLangs, ["fr", "de"]);
});

test("the <html> element is not counted as a PART of itself", () => {
  // A page declaring `<html lang="en">` and nothing else has ZERO language parts. Counting the document
  // element among them would make every correctly-declared page look like it marks a passage.
  const out = runAgainst([], [], { documentLang: "en", parts: [] });
  assert.deepEqual(out.partLangs, []);
  assert.equal(out.partLangCount, 0);
});

test("part languages are DEDUPLICATED, and normalised for comparison", () => {
  // A page marking forty quotations in French is one fact. And `FR` and `fr` are the same language: BCP-47
  // is case-insensitive, and a comparison that treats them as different would report a change that a
  // screen reader does not make.
  const out = runAgainst([], [], { documentLang: "EN", parts: [langEl("fr"), langEl("FR"), langEl(" fr ")] });
  assert.deepEqual(out.partLangs, ["fr"]);
  assert.equal(out.documentLang, "en");
  // The COUNT is not deduplicated — three elements carry a lang, and that is a different question from
  // how many languages appear. Same split as `unnamedGraphics` beside `unnamedGraphicCount`.
  assert.equal(out.partLangCount, 3);
});

test("a page with no lang anywhere says so, rather than throwing", () => {
  const out = runAgainst([], [], {});
  assert.equal(out.documentLang, "");
  assert.deepEqual(out.partLangs, []);
});
