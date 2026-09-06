/**
 * WHERE DID OUR OWN NAVIGATION LAND? — the bracketing rule, pinned as pure logic.
 *
 * `sameDocument` compares CDP's `target.url` against the REQUESTED url, so a page that redirects reads as
 * a different document and `choosePageTarget` returns `targetMatch: "fallback"`. Downstream,
 * `censusTargetIsSuspect`/`focusTargetIsSuspect` turn that into "cannot say" — so census findings and
 * `focusEvents` are SUPPRESSED on a page that was, in fact, the one we asked for.
 *
 * `sameDocument`'s own comment refuses the obvious fix, correctly: CDP's `target.url` is *"exactly the
 * value this function exists to doubt"*. `resolvedNavigationUrl` answers that objection rather than
 * dodging it — a `Page.frameNavigated` seen between our own `Page.navigate` and its `Page.loadEventFired`
 * is a CAUSAL event tied to a navigation we initiated, not a report of where a target happens to be.
 *
 * **THE BRACKETS ARE WHAT MAKE THAT TRUE**, so they are what these tests are about. Take "the last
 * `frameNavigated` we saw" without them and the objection returns wearing a new event name — which is why
 * each of the four rules below has its own case rather than being covered incidentally by a happy path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { choosePageTarget } from "./browser-session.mjs";

import { resolvedNavigationUrl } from "./capture-pure.mjs";

const REQUESTED = "http://203.0.113.79:5050/focus-panel/bad.html";

/** A main-frame navigation: no `parentId`. */
const mainFrame = (url: string) => ({ method: "Page.frameNavigated", params: { frame: { url } } });

/** A subframe navigation — the consent iframe, which is the real case this must ignore. */
const subFrame = (url: string) => ({
  method: "Page.frameNavigated",
  params: { frame: { url, parentId: "FRAME-ROOT-1" } },
});

const loadEvent = { method: "Page.loadEventFired" };

test("no redirect: the resolved url IS the requested one, and nothing claims otherwise", () => {
  const out = resolvedNavigationUrl({ events: [mainFrame(REQUESTED), loadEvent], requested: REQUESTED });
  assert.equal(out.url, REQUESTED);
  assert.equal(out.redirected, false, "landing where we asked is not a redirect");
  assert.equal(out.afterLoad, null);
});

test("a CHAIN resolves to the LAST hop before the load event, not the first", () => {
  // A redirect chain emits several. The first is where we were sent; the last is where we arrived, and
  // taking the first would keep reporting the URL that is already known to be stale.
  const out = resolvedNavigationUrl({
    events: [
      mainFrame(REQUESTED),
      mainFrame("http://example.test/interstitial"),
      mainFrame("http://example.test/final"),
      loadEvent,
    ],
    requested: REQUESTED,
  });
  assert.equal(out.url, "http://example.test/final");
  assert.equal(out.redirected, true);
  assert.equal(out.hops, 3, "every main-frame hop is counted, so a chain is visible as a chain");
});

test("a SUBFRAME navigation is ignored — a consent iframe must not become the resolved url", () => {
  // The noise this exists to cut through. Without the parentId filter the resolved url becomes the consent
  // vendor's, and every downstream target match then compares against a document nobody asked for.
  const out = resolvedNavigationUrl({
    events: [
      mainFrame(REQUESTED),
      subFrame("https://consent.vendor.test/banner"),
      subFrame("https://consent.vendor.test/banner?accepted=1"),
      loadEvent,
    ],
    requested: REQUESTED,
  });
  assert.equal(out.url, REQUESTED, "the main frame never moved, so nothing redirected");
  assert.equal(out.redirected, false);
  assert.equal(out.hops, 1, "only the main-frame event counts as a hop");
});

test("a navigation AFTER the load event is a DIFFERENT finding, and is never folded in", () => {
  // A page that navigates itself post-load is real and worth recording. It is not where OUR request
  // resolved to, and folding it in would let the page's own later navigation rewrite what we believe we
  // asked for -- which is the objection this whole mechanism exists to answer, arriving from inside.
  const out = resolvedNavigationUrl({
    events: [mainFrame(REQUESTED), loadEvent, mainFrame("http://example.test/self-redirect")],
    requested: REQUESTED,
  });
  assert.equal(out.url, REQUESTED, "the resolved url is bounded by the load event");
  assert.equal(out.afterLoad, "http://example.test/self-redirect",
    "and the post-load navigation is REPORTED rather than dropped -- it is a finding, not noise");
});

test("events with no load event at all still resolve, and claim no post-load navigation", () => {
  // The navigate timed out or the socket closed early. The chain we did see is still rooted at our own
  // navigate, so it is still usable; what we cannot claim is that anything happened after a load we never
  // observed. `afterLoad: null` there means "no such finding", not "we checked and there was none".
  const out = resolvedNavigationUrl({
    events: [mainFrame(REQUESTED), mainFrame("http://example.test/final")],
    requested: REQUESTED,
  });
  assert.equal(out.url, "http://example.test/final");
  assert.equal(out.afterLoad, null);
});

test("no events at all falls back to the requested url, so a caller never decides what silence means", () => {
  const out = resolvedNavigationUrl({ events: [], requested: REQUESTED });
  assert.equal(out.url, REQUESTED);
  assert.equal(out.redirected, false);
  assert.equal(out.hops, 0);
});

test("a frame with an EMPTY parentId is still a subframe, not a main frame", () => {
  // Checked as ABSENT rather than falsy: treating "" as a main frame would silently admit a subframe, and
  // this is the kind of narrowing that looks equivalent and is not.
  const out = resolvedNavigationUrl({
    events: [
      mainFrame(REQUESTED),
      { method: "Page.frameNavigated", params: { frame: { url: "http://example.test/x", parentId: "" } } },
      loadEvent,
    ],
    requested: REQUESTED,
  });
  assert.equal(out.url, REQUESTED);
});

test("a URL differing only by NORMALISATION is not a redirect", () => {
  // THE GUARD USED `!==`, inside the one function that exists because raw URL comparison is wrong.
  // `samePath` reconciles `.html`/`.php` and trailing-slash forms; a raw comparison calls those a redirect
  // and fires the branch on a page that never redirected. Measured 2026-09-06: three of 48 synthetic cases
  // moved `postSubmitNames` — identical text, different AX node boundaries — while 45 did not, which is a
  // fixed repeatable URL difference, not a redirect.
  const pages = [{ id: "t", type: "page", url: "http://h:5050/case/bad", webSocketDebuggerUrl: "ws://x" }];
  const withResolved = choosePageTarget(pages, "http://h:5050/case/bad.html", "http://h:5050/case/bad");
  const without = choosePageTarget(pages, "http://h:5050/case/bad.html");
  // THE DISCRIMINATOR IS `resolvedUrl`, not the label. Both paths answer `matched`; only the redirect
  // branch attaches a `resolvedUrl`, so its absence is what proves the branch was not taken. My first
  // version of this asserted a `targetMatch: "exact"` that does not exist — the labels are
  // matched | fallback | no-expected-url — and would have failed against a correct fix.
  assert.equal(withResolved?.targetMatch, without?.targetMatch,
    "a normalised-only difference must reach the same verdict as no resolvedUrl at all");
  assert.equal(withResolved?.resolvedUrl, undefined,
    "the redirect branch must NOT fire on a URL that differs only by normalisation");
});

test("a genuine redirect still resolves to the landed target", () => {
  // The other direction, so the fix above cannot be 'never take the branch'.
  const pages = [{ id: "t", type: "page", url: "https://site/status#x", webSocketDebuggerUrl: "ws://x" }];
  const chosen = choosePageTarget(pages, "https://site/modes/tube/", "https://site/status#x");
  assert.equal(chosen?.targetMatch, "matched");
  assert.equal(chosen?.resolvedUrl, "https://site/status#x");
});

test("the resolved URL is CLEARED before each navigation, so it can never be a previous capture's answer", () => {
  // THE REAL DEFECT, and the one that reaches `choosePageTarget`'s redirect branch.
  //
  // `resolvedNavigationUrl` returns the REQUESTED url when nothing redirected, so `resolvedPageUrl` never
  // becomes null on its own: after a capture of page A it holds A. `pageTarget()` runs at the TOP of the
  // next `navigateExisting`, BEFORE that capture has navigated, and `A11Y_REUSE_BROWSER` is on by default
  // so the window is still showing A. Capture N+1 of page B therefore calls
  // `choosePageTarget(expectedUrl = B, resolvedUrl = A)`: nothing matches B, the branch fires, it finds
  // the target still showing A, and returns `targetMatch: "matched"` for THE PREVIOUS PAGE'S DOCUMENT.
  //
  // That is a capture reading the wrong document and calling it a confident match — which is exactly what
  // `targetMatch` exists to prevent, arriving through stale state instead of through a bad comparison.
  //
  // Asserted on SOURCE ORDER because the behaviour needs a live CDP socket: the reset must precede the
  // navigate, not merely follow the load. A reset placed after `Page.navigate` would leave the window
  // between the two calls holding the old value, which is the moment `pageTarget()` reads it.
  const src = readFileSync(new URL("./browser-session.mjs", import.meta.url), "utf8");
  // SCOPED TO THE FUNCTION rather than anchored on an indent. This searched for
  // `"\n    resolvedPageUrl = null;"` — four spaces, i.e. inside the `try` — which pinned the statement's
  // INDENTATION as though that were the property. It is not: the property is that nothing can read the
  // value before it is cleared, and the fix for the defect this test describes moves the reset OUT to the
  // function's first statement, where it is indented by two. A guard that fails on its own remedy is
  // worse than no guard, and the earlier bare-string version passed with the reset deleted. Slicing the
  // function is what makes both mistakes unavailable.
  const fn = src.slice(src.indexOf("export async function navigateExisting("));
  const reset = fn.indexOf("resolvedPageUrl = null");
  const readsIt = fn.indexOf("await pageTarget()");
  const navigate = fn.indexOf('method: "Page.navigate"');
  const assign = fn.indexOf("resolvedPageUrl = resolvedNavigationUrl(");
  assert.ok(fn.length > 0, "navigateExisting not found -- this guard is reading the wrong thing");
  assert.ok(reset > -1, "resolvedPageUrl must be explicitly cleared; it never becomes null on its own");
  assert.ok(readsIt > -1, "navigateExisting no longer calls pageTarget() -- re-check what this guards");

  // THE ASSERTION THIS TEST'S OWN COMMENT ALWAYS DESCRIBED, and did not make until 2026-09-06.
  //
  // Everything above says the defect is `pageTarget()` reading the value at the TOP of the next
  // `navigateExisting`. The check was `reset < navigate` — and the reset sat after `pageTarget()` and
  // before `Page.navigate`, so the defective arrangement SATISFIED IT. A correct diagnosis in prose,
  // above an assertion of a weaker property that the described defect passes: the shape
  // `not-working.md` §26 is about, occurring inside the guard written for it.
  assert.ok(reset < readsIt,
    "`resolvedPageUrl = null` must come before `await pageTarget()`, which is the call that READS it on "
    + "its way to choosePageTarget. A reset that is merely before Page.navigate is too late: by then "
    + "capture N+1 has already chosen its target against capture N's resolved URL, on a reused window "
    + "still showing capture N's page. The stale value is a real URL, so it neither throws nor reads as "
    + "absent -- the run reports a matched target and captures the wrong document.");
  assert.ok(reset < navigate, "the clear must come BEFORE Page.navigate, not after");
  assert.ok(navigate < assign, "and the assignment after the navigation it describes");
});
