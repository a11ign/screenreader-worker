/**
 * #1850: `routeChange.navigated` is derived from NVDA's own document-change announcement, replacing the
 * `navigated: true` literal `probeRouteChange` wrote on every successful activation regardless of whether
 * the view actually moved. Imports only `capture-pure.mjs`: `capture-probes.mjs` imports
 * `@guidepup/guidepup`, which throws at import where no screen reader exists, so the decision lives in the
 * pure module (`route-change-focus-after.test.ts`'s own reason) and the WIRING test below reads the probe
 * as text instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { routeChangeNavigated } from "./capture-pure.mjs";

test("#1850 ACCEPTANCE: a confirmed document announcement reads navigated", () => {
  // The corpus's own shape, `capture-probes.mjs:2050`'s comment quotes a real one.
  assert.equal(routeChangeNavigated("Energy results, document"), true);
  assert.equal(routeChangeNavigated("Web Accessibility Perspectives, document"), true);
});

test("#1850 MUTATION: a control that activates and navigates nowhere reads false", () => {
  // The canary this row's own Mutation line asks for: an activation whose announcement is the control's
  // own state, or a page that plainly stayed put -- neither is a document confirmation.
  assert.equal(routeChangeNavigated("visited"), false, "the link's own visited state, not a page arriving");
  assert.equal(routeChangeNavigated("checked"), false, "a checkbox's own state -- the control, not the page");
  assert.equal(routeChangeNavigated(""), false, "nothing announced after a settled activation: no document arrived");
  assert.equal(routeChangeNavigated(null), false);
  assert.equal(routeChangeNavigated(undefined), false);
});

test("#1850: the two named near-misses -- 'document, busy' -- now match, where the unwidened pattern did not", () => {
  // `disinfectants-defra-gov-uk*.json`, #142's own measurement: a genuine navigation the anchored
  // `/,\s*document$/i` under-matched.
  assert.equal(routeChangeNavigated("Disinfectants, document, busy"), true);
});

test("#1850: 'Loading page' only -- a real navigation whose fuller confirmation never arrived -- reads false, "
  + "accepted rather than silently misread as no navigation", () => {
  // design-system-service-gov-uk-components-{accordion,checkboxes,date-input,error-message,select,table}.json:
  // the observation window ended before NVDA's post-load confirmation, per #142's own measurement. This is the
  // accepted limitation `routeChangeNavigated`'s own comment names -- pinned here so a future widening of the
  // wait is a deliberate change to this test, not a silent behaviour shift.
  assert.equal(routeChangeNavigated("Loading page"), false);
});

test("#1850: an unrelated document announced mid-delta, with more text after it, does not match -- anchored to the end", () => {
  assert.equal(routeChangeNavigated("Video, frame, document, clickable"), false,
    "a role named 'document' followed by more text is not this activation's own confirmation");
});

test("#1850 WIRING: probeRouteChange's success path derives navigated from routeChangeNavigated, "
  + "and the unconditional literal is gone", () => {
  // READ AS TEXT, never imported -- see this file's header. Anchored on code shapes, matching
  // `route-change-focus-after.test.ts`'s own WIRING test and #142's own Open-check.
  const source = readFileSync(new URL("./capture-probes.mjs", import.meta.url), "utf8");
  assert.match(source, /\breadFocusAfterTab, routeChangeNavigated,\n\} from "\.\/capture-pure\.mjs";/,
    "the helper is imported from the pure module");
  assert.doesNotMatch(source, /navigated: true,/, "#142's own Open-check: no unconditional literal on the success path");
  const start = source.indexOf("async function probeRouteChange(");
  assert.ok(start >= 0, "probeRouteChange is gone from capture-probes.mjs");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /navigated: routeChangeNavigated\(activation\?\.after\)/,
    "the field is derived from the same announcement the mark itself records");
});
