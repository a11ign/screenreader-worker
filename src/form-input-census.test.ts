/**
 * #170: EVERY FORM CONTROL'S `autocomplete` ATTRIBUTE -- the census 1.3.5's rule has been waiting for.
 *
 * `addUnidentifiedInputPurpose` (`packages/judge/src/rules.ts`) and the `inputPurposeInvalid` signal read
 * `capture.formInputs`, and on every capture before this none existed: `if (!input.formInputs) return;`. This
 * is the worker-side census that fills it, mirroring `mediaCensus` for `media`.
 *
 * THE EXPRESSION IS IMPORTED, not scraped from the source: `FORM_INPUT_CENSUS_EXPRESSION` is the evaluated
 * template literal, so this runs the very string the page receives (#969's lesson, applied here from the
 * start). It runs against a synthetic DOM, the way `dom-census-expression.test.ts` runs `domCensus`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FORM_INPUT_CAP, FORM_INPUT_CENSUS_EXPRESSION } from "./browser-session.mjs";
import { oracleCounts } from "@a11ign/evidence/verify";

type Control = { tagName: string, getAttribute: (k: string) => string | null, autocomplete?: string };
/** A control as page script sees it. `autocomplete` the PROPERTY is what the browser normalises -- see below. */
const control = (tag: string, attrs: Record<string, string> = {}, property?: string): Control => ({
  tagName: tag.toUpperCase(),
  getAttribute: (k: string) => attrs[k] ?? null,
  ...(property !== undefined ? { autocomplete: property } : {}),
});

type Census = { total: number, elements: { tag: string, type: string | null, autocomplete: string | null }[] };
/** Run the census against a page whose `input, select, textarea` are `controls`. */
function censusOf(controls: Control[]): Census {
  const document = {
    querySelectorAll: (selector: string) => {
      assert.equal(selector, "input, select, textarea", "the census asks for the controls autocomplete applies to");
      return controls;
    },
  };
  return new Function("document", `return ${FORM_INPUT_CENSUS_EXPRESSION}`)(document) as Census;
}

test("#170: one entry per control, in the shape verify.ts already declares -- { tag, type, autocomplete }", () => {
  const { elements, total } = censusOf([
    control("input", { type: "text", autocomplete: "given-name" }),
    control("input", { type: "email", autocomplete: "email" }),
  ]);
  assert.equal(total, 2);
  assert.deepEqual(elements, [
    { tag: "input", type: "text", autocomplete: "given-name" },
    { tag: "input", type: "email", autocomplete: "email" },
  ]);
  for (const entry of elements) assert.deepEqual(Object.keys(entry), ["tag", "type", "autocomplete"]);
});

test("#170 THE DISCRIMINATING PAIR: a control WITHOUT the attribute is reported, and a page with NO control is empty", () => {
  // "No control carries the attribute" and "no control was examined" must come back as different values. A
  // census that skipped attribute-less controls would return [] for both, and the rule could not tell them apart.
  const removed = censusOf([control("input", { type: "text" })]);
  assert.deepEqual(removed.elements, [{ tag: "input", type: "text", autocomplete: null }],
    "the control is there; its attribute is ABSENT, which is null -- never a skipped entry");
  assert.equal(removed.total, 1);
  const none = censusOf([]);
  assert.deepEqual(none, { total: 0, elements: [] }, "a page with no form control");
  assert.notDeepEqual(removed.elements, none.elements, "the two pages must not read the same");
});

test("#170: the ATTRIBUTE, never the property -- the browser normalises a malformed token to \"\"", () => {
  // `el.autocomplete` is the IDL value, which Chromium returns as "" for a token it does not recognise. F107's
  // syntactic half exists to catch exactly those tokens, so reading the property would hide every one.
  const { elements } = censusOf([control("input", { autocomplete: "fname" }, "")]);
  assert.equal(elements[0]?.autocomplete, "fname");
  assert.equal(censusOf([control("input", { autocomplete: "" })]).elements[0]?.autocomplete, "",
    "an empty attribute is present and empty, not absent -- the rule decides what \"\" claims");
});

test("#170: type is the attribute, lower-cased, \"text\" when absent; null where there is no type; hidden is not a control", () => {
  const { elements, total } = censusOf([
    control("input"),
    control("input", { type: "EMAIL" }),
    control("input", { type: "hidden", autocomplete: "fname" }),
    control("select", { autocomplete: "country" }),
    control("textarea", { autocomplete: "street-address" }),
  ]);
  assert.equal(total, 4, "an <input type=hidden> collects nothing from the user and is not counted");
  assert.deepEqual(elements.map((e) => [e.tag, e.type]), [["input", "text"], ["input", "email"], ["select", null], ["textarea", null]]);
});

test("#170: the list is capped at FORM_INPUT_CAP, and `total` says when it was", () => {
  const many = Array.from({ length: FORM_INPUT_CAP + 1 }, () => control("input", { autocomplete: "email" }));
  const { elements, total } = censusOf(many);
  assert.equal(elements.length, FORM_INPUT_CAP);
  assert.equal(total, FORM_INPUT_CAP + 1, "a truncated list that reads as complete is the defect one layer on");
});

test("#170 WIRED: read beside mediaCensus, put on the capture as `formInputs`, and it reaches ruleEvidence", () => {
  const source = (file: string) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
  const probes = source("capture-probes.mjs");
  const reads = probes.slice(probes.indexOf("async function censusBeforeNavigating(diag) {"));
  assert.match(reads.slice(0, reads.indexOf("\n}\n")), /await mediaCensus\(\);[\s\S]*await formInputCensus\(\);/,
    "the census is read at the same moment as mediaCensus, before any navigating probe");
  assert.match(probes, /result\.formInputs = formsRead\?\.elements \?\? null;/,
    "`.elements` onto the result, null when the census did not run -- never an empty list for 'not checked'");
  assert.match(source("capture-core.mjs"), /\n {4}formInputs,\n/, "and onto the capture object itself");
  // `oracleCounts` is how a rule reaches it (verify.ts: `formInputs` passed through to ruleEvidence).
  const { elements } = censusOf([control("input", { type: "text", autocomplete: "fname" })]);
  const counts = oracleCounts({ transcript: [], structure: {}, interaction: {}, formInputs: elements } as never);
  assert.deepEqual(counts.formInputs, elements, "what the census wrote is what 1.3.5's rule reads");
});
