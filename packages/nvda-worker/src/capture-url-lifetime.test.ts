/**
 * #1200: THE TWO CAPTURE URLS HAVE ONE LIFETIME, AND ONLY ONE OF THEM WAS CLEARED AT THAT BOUNDARY.
 *
 * `expectedPageUrl` and `resolvedPageUrl` both mean "for the capture `openPage` most recently started".
 * `captureWithNvda`'s `finally` cleared the first, with a comment naming exactly why: *"an expectation set
 * by THIS capture and never cleared is not an edge case, it is the normal state between requests -- every
 * `pageTarget()` call outside a capture (`/diagnostics`, a `bringPageToFront` between cases) would
 * otherwise compare the live target against the PREVIOUS capture's URL."*
 *
 * **Every word of that was true of the value sitting next to it, and nothing cleared that one.**
 * `resolvedPageUrl`'s only reset was the first statement of `navigateExisting` -- per NAVIGATION, not per
 * capture, and it does not run at all on a capture that never navigates: a fresh `--app=` launch sets the
 * URL by command line, and a capture that throws before navigating never reaches it. So between captures
 * the resolved URL was the previous capture's landing page, and `choosePageTarget` was given it.
 *
 * The fix is one record with one reset, so the pair cannot be half-cleared. A one-field wrapper around
 * `resolvedPageUrl` alone would have satisfied "not module-level" as a grep and changed nothing.
 *
 * WHAT IS DRIVEN AND WHAT IS READ, stated rather than blurred. `endCaptureUrls` and the expected half are
 * DRIVEN -- real calls, real values, and the failure prints the URL that survived. The resolved half
 * cannot be set from here at all: only `navigateExisting` writes it, and that opens a WebSocket to a real
 * Edge. So its arrangement is READ FROM SOURCE, which is the same choice `resolved-page-url-reset.test.ts`
 * makes and for the reason it gives -- a statement's presence is a syntactic property, and the mutation
 * this row specifies (restore the module-level binding) is itself syntactic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripComments } from "@a11ign/evidence/source-text";
import { setExpectedPageUrl, expectedPageUrlForTest, lastResolvedPageUrl, endCaptureUrls }
  from "./browser-session.mjs";

const SESSION = readFileSync(resolve(import.meta.dirname, "browser-session.mjs"), "utf8");
// COMMENTS STRIPPED, and this guard caught its own author doing it. The first version matched
// `setExpectedPageUrl(null)` in the COMMENT I wrote at the new call site explaining what used to stand
// there -- so the check went red against correct code, for prose. It is the #1197 defect (a guard reading
// its own paragraph) reproduced the same night by the person who had just fixed it, which is the argument
// for the shared helper over remembering. `SESSION` is deliberately NOT stripped: its assertions are about
// declarations and the literal record, where a comment cannot produce a false pass.
const CORE = stripComments(readFileSync(resolve(import.meta.dirname, "capture-core.mjs"), "utf8"));

test("#1200: endCaptureUrls clears the EXPECTED url, driven, with the survivor named", () => {
  const url = "https://example.com/capture-A/search?q=1";
  setExpectedPageUrl(url);
  // POSITIVE CONTROL, before the assertion that matters: a test whose setup silently did nothing passes
  // the clear-check for the wrong reason, and prints the same two numbers as one that worked.
  assert.equal(expectedPageUrlForTest(), url,
    "the setter did not take, so the clear below would pass having cleared nothing");
  endCaptureUrls();
  assert.equal(expectedPageUrlForTest(), null,
    `the previous capture's expected URL survived the capture boundary: ${expectedPageUrlForTest()}`);
});

/**
 * VACUOUS BY CONSTRUCTION, AND SAYING SO IS THE POINT. Nothing reachable from a test can make
 * `captureUrls.resolved` non-null -- only `navigateExisting` writes it, through a real CDP socket -- so
 * this reads null before the call as well as after. MEASURED: under the mutation that drops
 * `captureUrls.resolved = null` from `endCaptureUrls`, **this test still passes**; only the source-read
 * below goes red. It is kept because it is the consumer-side spelling of the property and would catch a
 * future `lastResolvedPageUrl` that returned something else, but **it must not be read as coverage** --
 * the guard that actually holds this is `endCaptureUrls assigns BOTH fields`.
 */
test("#1200: endCaptureUrls clears the RESOLVED url too -- vacuous today, see the comment above", () => {
  endCaptureUrls();
  assert.equal(lastResolvedPageUrl(), null,
    `the previous capture's RESOLVED URL survived the capture boundary: ${lastResolvedPageUrl()}. `
    + "Every `pageTarget()` call until the next navigateExisting would compare against it.");
});

test("#1200: neither url is a bare module-level binding -- one record, so neither can be half-cleared", () => {
  // The row's mutation, as an assertion: restoring `let resolvedPageUrl = null` at module scope must fail
  // here, naming the binding rather than reporting a count.
  const bare = [...SESSION.matchAll(/^(?:let|var)\s+(expectedPageUrl|resolvedPageUrl)\b.*$/gm)]
    .map((m) => m[0].trim());
  assert.deepEqual(bare, [],
    `${bare.length} capture URL(s) are back as bare module-level bindings, so each has its own lifetime `
    + `again and one can be cleared while the other is forgotten:\n  ${bare.join("\n  ")}`);
  assert.match(SESSION, /const captureUrls = \{ expected: null, resolved: null \};/,
    "the single record is gone -- if it was replaced, this guard needs rewriting rather than deleting");
});

test("#1200: endCaptureUrls assigns BOTH fields, so the pair cannot be half-cleared", () => {
  const at = SESSION.indexOf("export function endCaptureUrls() {");
  assert.notEqual(at, -1, "endCaptureUrls is gone or renamed -- this guard's subject, not a pass");
  const body = SESSION.slice(at, SESSION.indexOf("\n}\n", at));
  const cleared = ["expected", "resolved"].filter((f) => body.includes(`captureUrls.${f} = null;`));
  assert.deepEqual(cleared, ["expected", "resolved"],
    `endCaptureUrls clears ${JSON.stringify(cleared)} -- clearing one of a pair with one lifetime is the `
    + "defect this row is about, and it is what the function is named for");
});

test("#1200: the capture boundary CALLS it -- a reset nothing invokes is the defect with a new name", () => {
  assert.match(CORE, /\bendCaptureUrls\(\);/,
    "capture-core no longer calls endCaptureUrls, so nothing clears either URL when a capture ends");
  assert.ok(!/\bsetExpectedPageUrl\(null\)/.test(CORE),
    "capture-core is clearing only the expectation again -- that is the half-reset #1200 replaced");
});
