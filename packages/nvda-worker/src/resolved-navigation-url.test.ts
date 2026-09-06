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

import { resolvedNavigationUrl } from "./capture-pure.mjs";

const REQUESTED = "http://REDACTED-INTERNAL-ADDRESS:5050/focus-panel/bad.html";

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
