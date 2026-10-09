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

import { FORM_INPUT_CAP, FORM_INPUT_CENSUS_EXPRESSION } from "./browser-session.ts";
import { oracleCounts } from "@a11ign/evidence/verify";

type Control = {
  tagName: string, getAttribute: (k: string) => string | null, autocomplete?: string, form?: unknown, required?: boolean,
  value?: string, valueStore?: string,
  dispatchEvent?: (event: { type: string, cancelable: boolean, bubbles: boolean }) => boolean,
};
/** A control as page script sees it. `autocomplete` the PROPERTY is what the browser normalises -- see below. */
const control = (tag: string, attrs: Record<string, string> = {}, property?: string): Control => ({
  tagName: tag.toUpperCase(),
  getAttribute: (k: string) => attrs[k] ?? null,
  ...(property !== undefined ? { autocomplete: property } : {}),
});

type Census = {
  total: number,
  elements: {
    tag: string, type: string | null, autocomplete: string | null, form?: number, required: boolean,
    pasteCancelled?: boolean, populatedFromEarlier?: boolean,
  }[],
};
/** The page's `Event`: a type, and nothing else the expression reads. */
class FakeEvent {
  constructor(readonly type: string, readonly init: { bubbles?: boolean } = {}) {}
}
/** `HTMLInputElement.prototype.value`'s native setter, which is the route the census must take: it stores the value
 * WITHOUT running a page's own `value` override, as a framework's controlled input requires. */
class FakeHTMLInputElement {
  valueStore = "";
  get value(): string { return this.valueStore; }
  set value(next: string) { this.valueStore = next; }
}
/** The page's `ClipboardEvent`, reduced to what the expression passes it: a type and its init. */
class FakeClipboardEvent {
  cancelable: boolean;
  bubbles: boolean;
  constructor(readonly type: string, init: { cancelable?: boolean, bubbles?: boolean } = {}) {
    this.cancelable = init.cancelable ?? false;
    this.bubbles = init.bubbles ?? false;
  }
}
/** Run the census against a page whose `input, select, textarea` are `controls`. */
async function censusOf(controls: Control[], forms: unknown[] = []): Promise<Census> {
  const document = {
    forms,
    querySelectorAll: (selector: string) => {
      assert.equal(selector, "input, select, textarea", "the census asks for the controls autocomplete applies to");
      return controls;
    },
  };
  return await new Function("document", "ClipboardEvent", "Event", "HTMLInputElement", `return ${FORM_INPUT_CENSUS_EXPRESSION}`)(
    document, FakeClipboardEvent, FakeEvent, FakeHTMLInputElement) as Census;
}

test("#170: one entry per control, in the shape verify.ts already declares -- { tag, type, autocomplete }, plus required (#4361)", async () => {
  const { elements, total } = await censusOf([
    control("input", { type: "text", autocomplete: "given-name" }),
    control("input", { type: "email", autocomplete: "email" }),
  ]);
  assert.equal(total, 2);
  assert.deepEqual(elements, [
    { tag: "input", type: "text", autocomplete: "given-name", required: false },
    { tag: "input", type: "email", autocomplete: "email", required: false },
  ]);
  for (const entry of elements) assert.deepEqual(Object.keys(entry), ["tag", "type", "autocomplete", "required"]);
});

test("#170 THE DISCRIMINATING PAIR: a control WITHOUT the attribute is reported, and a page with NO control is empty", async () => {
  // "No control carries the attribute" and "no control was examined" must come back as different values. A
  // census that skipped attribute-less controls would return [] for both, and the rule could not tell them apart.
  const removed = await censusOf([control("input", { type: "text" })]);
  assert.deepEqual(removed.elements, [{ tag: "input", type: "text", autocomplete: null, required: false }],
    "the control is there; its attribute is ABSENT, which is null -- never a skipped entry");
  assert.equal(removed.total, 1);
  const none = await censusOf([]);
  assert.deepEqual(none, { total: 0, elements: [] }, "a page with no form control");
  assert.notDeepEqual(removed.elements, none.elements, "the two pages must not read the same");
});

test("#170: the ATTRIBUTE, never the property -- the browser normalises a malformed token to \"\"", async () => {
  // `el.autocomplete` is the IDL value, which Chromium returns as "" for a token it does not recognise. F107's
  // syntactic half exists to catch exactly those tokens, so reading the property would hide every one.
  const { elements } = await censusOf([control("input", { autocomplete: "fname" }, "")]);
  assert.equal(elements[0]?.autocomplete, "fname");
  assert.equal((await censusOf([control("input", { autocomplete: "" })])).elements[0]?.autocomplete, "",
    "an empty attribute is present and empty, not absent -- the rule decides what \"\" claims");
});

test("#170: type is the attribute, lower-cased, \"text\" when absent; null where there is no type; hidden is not a control", async () => {
  const { elements, total } = await censusOf([
    control("input"),
    control("input", { type: "EMAIL" }),
    control("input", { type: "hidden", autocomplete: "fname" }),
    control("select", { autocomplete: "country" }),
    control("textarea", { autocomplete: "street-address" }),
  ]);
  assert.equal(total, 4, "an <input type=hidden> collects nothing from the user and is not counted");
  assert.deepEqual(elements.map((e) => [e.tag, e.type]), [["input", "text"], ["input", "email"], ["select", null], ["textarea", null]]);
});

test("#170: the list is capped at FORM_INPUT_CAP, and `total` says when it was", async () => {
  const many = Array.from({ length: FORM_INPUT_CAP + 1 }, () => control("input", { autocomplete: "email" }));
  const { elements, total } = await censusOf(many);
  assert.equal(elements.length, FORM_INPUT_CAP);
  assert.equal(total, FORM_INPUT_CAP + 1, "a truncated list that reads as complete is the defect one layer on");
});

test("#170 WIRED: read beside mediaCensus, put on the capture as `formInputs`, and it reaches ruleEvidence", async () => {
  const source = (file: string) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
  const probes = source("capture-probes.ts");
  const reads = probes.slice(probes.indexOf("async function censusBeforeNavigating("));
  assert.match(reads.slice(0, reads.indexOf("\n}\n")), /await mediaCensus\(\);[\s\S]*await formInputCensus\(\);/,
    "the census is read at the same moment as mediaCensus, before any navigating probe");
  assert.match(probes, /result\.formInputs = formsRead\?\.elements \?\? null;/,
    "`.elements` onto the result, null when the census did not run -- never an empty list for 'not checked'");
  assert.match(source("capture-core.ts"), /\n {4}formInputs,\n/, "and onto the capture object itself");
  // `oracleCounts` is how a rule reaches it (verify.ts: `formInputs` passed through to ruleEvidence).
  const { elements } = await censusOf([control("input", { type: "text", autocomplete: "fname" })]);
  const counts = oracleCounts({ transcript: [], structure: {}, interaction: {}, formInputs: elements } as never);
  assert.deepEqual(counts.formInputs, elements, "what the census wrote is what 1.3.5's rule reads");
});

/** A password field whose `paste` listener cancels (`cancels`) or does not; `seen` collects what it was dispatched. */
function passwordField(cancels: boolean, seen: { type: string, cancelable: boolean, bubbles: boolean }[] = []): Control {
  return {
    ...control("input", { type: "password" }),
    // `dispatchEvent` is false exactly when a listener called preventDefault on a cancelable event.
    dispatchEvent: (event) => { seen.push({ type: event.type, cancelable: event.cancelable, bubbles: event.bubbles }); return !(cancels && event.cancelable); },
  };
}

test("#4314 THE DISCRIMINATING PAIR: a password field that cancels paste reads true, one that does not reads false", async () => {
  const seen: { type: string, cancelable: boolean, bubbles: boolean }[] = [];
  const { elements } = await censusOf([passwordField(true, seen), passwordField(false)]);
  assert.equal(elements[0]?.pasteCancelled, true, "onpaste=\"return false\" or a paste listener that preventDefaults");
  assert.equal(elements[1]?.pasteCancelled, false, "paste is allowed: false, which is a measurement and not 'absent'");
  assert.deepEqual(seen, [{ type: "paste", cancelable: true, bubbles: true }],
    "the event is a cancelable, bubbling `paste` -- a non-cancelable one could never read as cancelled");
});

test("#4314: only a password field is examined -- every other control has NO pasteCancelled key", async () => {
  const noDispatch = (tag: string, attrs: Record<string, string> = {}) => ({
    ...control(tag, attrs),
    dispatchEvent: () => assert.fail("a control that is not a password field must not be sent a paste event"),
  });
  const { elements } = await censusOf([
    noDispatch("input", { type: "text" }),
    noDispatch("input"),
    noDispatch("select"),
    noDispatch("textarea"),
    { ...passwordField(true), getAttribute: (k: string) => ({ type: " PassWord " })[k as "type"] ?? null },
  ]);
  for (const entry of elements.slice(0, 4)) assert.equal("pasteCancelled" in entry, false, `${entry.tag}/${entry.type}`);
  assert.equal(elements[4]?.pasteCancelled, true, "type is read as the lower-cased trimmed attribute, like `type` itself");
  assert.deepEqual(Object.keys(elements[4] ?? {}), ["tag", "type", "autocomplete", "required", "pasteCancelled"]);
});

/** A form as `document.forms` lists it. */
const aForm = () => ({});
/**
 * An `input` with a live `value`: reads and the native setter go through `FakeHTMLInputElement`'s accessor, and
 * `dispatchEvent` runs the listeners the page registered (`on`) for that event type.
 */
function field(attrs: Record<string, string>, opts: {
  form?: unknown, required?: boolean, value?: string, on?: Record<string, (self: Control) => void>,
} = {}): Control & { events: string[] } {
  const events: string[] = [];
  const self = Object.assign(Object.create(FakeHTMLInputElement.prototype) as FakeHTMLInputElement, {
    ...control("input", attrs),
    ...(opts.form !== undefined ? { form: opts.form } : {}),
    ...(opts.required !== undefined ? { required: opts.required } : {}),
    events,
    dispatchEvent: (event: { type: string }) => { events.push(event.type); opts.on?.[event.type]?.(self as never); return true; },
  }) as Control & { events: string[] };
  self.valueStore = opts.value ?? "";
  return self;
}
/** The page script that is the criterion's "auto-populated" branch: whatever lands in `from` is copied into `to`. */
const copiesInto = (to: () => Control) => ({ input: (self: Control) => { to().valueStore = self.valueStore; } });

test("#4361: `form` is the index in document.forms, ABSENT (never -1) with no owning form; `required` is the property", async () => {
  const [first, second] = [aForm(), aForm()];
  const { elements } = await censusOf([
    field({ type: "text" }, { form: second, required: true }),
    field({ type: "text" }, { form: first }),
    field({ type: "text" }),
    { ...control("select"), form: first, required: true },
    { ...control("textarea", { "aria-required": "true" }) },
  ], [first, second]);
  assert.deepEqual(elements.map((e) => e.form), [1, 0, undefined, 0, undefined]);
  assert.equal("form" in (elements[2] ?? {}), false, "no owning form means no key -- not -1");
  assert.deepEqual(elements.map((e) => e.required), [true, false, false, true, false],
    "the `required` property (select and textarea included); aria-required is not the attribute and does not count");
});

test("#4361 THE TRIO: the bad page's second email reads false; the good page's only email and the password pair carry no key", async () => {
  const bad = aForm();
  const confirmBad = await censusOf([
    field({ type: "email" }, { form: bad, required: true }), field({ type: "email" }, { form: bad, required: true }),
  ], [bad]);
  assert.equal("populatedFromEarlier" in (confirmBad.elements[0] ?? {}), false, "the first email has nothing earlier");
  assert.equal(confirmBad.elements[1]?.populatedFromEarlier, false, "typed into the first, the second stays empty");
  const good = aForm();
  const onceGood = await censusOf([field({ type: "email" }, { form: good, required: true })], [good]);
  assert.equal("populatedFromEarlier" in (onceGood.elements[0] ?? {}), false, "one email: nothing to compare against");
  const exception = aForm();
  const passwords = [field({ type: "password" }, { form: exception }), field({ type: "password" }, { form: exception })];
  const pair = await censusOf(passwords, [exception]);
  for (const entry of pair.elements) assert.equal("populatedFromEarlier" in entry, false, "only email is examined");
  assert.deepEqual(passwords.map((p) => p.events), [["paste"], ["paste"]], "no input or change event reached a password field");
});

test("#4361 THE DISCRIMINATING PAIR: a page that copies the earlier email into the later reads true, one that does not reads false", async () => {
  const form = aForm();
  const later = field({ type: "email" }, { form });
  const copying = field({ type: "email" }, { form, on: copiesInto(() => later) });
  const { elements } = await censusOf([copying, later], [form]);
  assert.equal(elements[1]?.populatedFromEarlier, true, "the criterion's auto-populated branch, read from the later field's value");
  const inert = field({ type: "email" }, { form });
  assert.equal((await censusOf([field({ type: "email" }, { form }), inert], [form])).elements[1]?.populatedFromEarlier, false);
});

test("#4361: the sentinel is written through the NATIVE setter, announced with input and change, and both values come back", async () => {
  const form = aForm();
  const seenBy: string[] = [];
  const later = field({ type: "email" }, { form, value: "kept@example.test" });
  const earlier = field({ type: "email" }, { form, value: "typed@example.test", on: {
    input: (self) => { seenBy.push(`input:${self.valueStore}`); to(later, self); },
    change: (self) => { seenBy.push(`change:${self.valueStore}`); },
  } });
  function to(target: Control, source: Control): void { target.valueStore = source.valueStore; }
  const { elements } = await censusOf([earlier, later], [form]);
  assert.equal(elements[1]?.populatedFromEarlier, true, "a value that CHANGED to the earlier field's counts, over a pre-filled one");
  assert.deepEqual(earlier.valueStore, "typed@example.test", "the earlier field holds what the visitor had typed");
  assert.deepEqual(later.valueStore, "kept@example.test", "the later field is put back, even though the page overwrote it");
  assert.ok(seenBy[0]?.startsWith("input:a11ign-census-sentinel@"), `the page saw the sentinel on input: ${seenBy.join(", ")}`);
  assert.ok(seenBy.some((s) => s.startsWith("change:a11ign-census-sentinel@")), "and on change");
});

test("#4361: a later email the SERVER pre-filled is not 'populated from the earlier one'", async () => {
  const form = aForm();
  const prefilled = field({ type: "email" }, { form, value: "server@example.test" });
  const { elements } = await censusOf([field({ type: "email" }, { form }), prefilled], [form]);
  assert.equal(elements[1]?.populatedFromEarlier, false, "non-empty before and after the sentinel, and unchanged");
  assert.equal(prefilled.valueStore, "server@example.test");
});

test("#4361: only a pair in ONE form is examined; the earlier is the nearest earlier email of that form", async () => {
  const [one, two] = [aForm(), aForm()];
  const apart = await censusOf([field({ type: "email" }, { form: one }), field({ type: "email" }, { form: two })], [one, two]);
  assert.equal("populatedFromEarlier" in (apart.elements[1] ?? {}), false, "two forms: not a confirmation field");
  const formless = await censusOf([field({ type: "email" }), field({ type: "email" })]);
  assert.equal("populatedFromEarlier" in (formless.elements[1] ?? {}), false, "no owning form: nothing is paired");
  const mixed = field({ type: "text" }, { form: one });
  const later = field({ type: "email" }, { form: one });
  const { elements } = await censusOf([field({ type: "email" }, { form: one }), mixed, later], [one]);
  assert.equal(elements[2]?.populatedFromEarlier, false, "a text field between them does not stop the pairing");
  assert.equal(mixed.events.length, 0, "the text field was neither written nor announced");
});

test("#4361 WIRED: the expression is evaluated with awaitPromise, or the census would be a Promise object", () => {
  const source = readFileSync(fileURLToPath(new URL("./browser-session.ts", import.meta.url)), "utf8");
  const call = source.slice(source.indexOf("expression: FORM_INPUT_CENSUS_EXPRESSION"));
  assert.match(call.slice(0, call.indexOf("}")), /awaitPromise: true/);
});
