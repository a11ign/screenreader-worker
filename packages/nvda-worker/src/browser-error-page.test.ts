/**
 * The browser's own error page is not the page under test.
 *
 * It has a title, a heading and text, so every readiness check passes and the capture is recorded as
 * evidence ABOUT THE SITE. Measured 2026-08-25: three fixture captures whose first transcript line was
 * `"heading, level 1, Hmmm... can't reach this page"`, from a run that reported "2/3 captured".
 *
 * TWO separate causes produced it in one afternoon — no page server running, and a `localhost` URL sent
 * unchanged to a remote worker whose localhost is itself. That is the argument for catching it at the
 * capture rather than in either fix: the ways to fail to reach a page are open-ended, and what they have
 * in common is the page you get instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// capture-core is plain .mjs; it runs under bare node on the worker.
import { isBrowserErrorTitle, samePath } from "./capture-core.mjs";

test("Edge's unreachable-page titles are refused", () => {
  for (const title of [
    "Hmmm... can't reach this page",
    "localhost refused to connect",
    "This site can't be reached",
    "No internet",
    "ERR_CONNECTION_REFUSED",
    "ERR_NAME_NOT_RESOLVED",
  ]) {
    assert.equal(isBrowserErrorTitle(title), true, title);
  }
});

test("a real page title is not mistaken for one", () => {
  // Including titles that mention connectivity, because the check is deliberately on the TITLE only —
  // a page ABOUT internet access is a page, and must capture normally.
  for (const title of [
    "Check for flooding - GOV.UK",
    "Get internet access at home - GOV.UK",
    "Report a connection problem | Ofgem",
    "Archive",
    "Delivery details",
  ]) {
    assert.equal(isBrowserErrorTitle(title), false, title);
  }
});

test("an absent title is not a browser error", () => {
  // `waitForDocument` already treats a blank title as "not ready yet" and retries. Conflating the two
  // would turn a slow page into a hard failure.
  assert.equal(isBrowserErrorTitle(""), false);
  assert.equal(isBrowserErrorTitle(undefined), false);
});

test("a server that resolves .html is not a different page", () => {
  // Measured 2026-08-25, and it cost a run: `serve` logs `GET /route-title-stale/bad` for a request to
  // `/bad.html` — it resolves the extension, so the browser's URL ends `/bad`. A strict comparison
  // rejected two captures that were completely correct and the run reported 0/3.
  //
  // A guard that fails on correct input gets switched off, which would lose the three real wrong-page
  // faults it was built to catch.
  assert.equal(samePath("/route-title-stale/bad", "/route-title-stale/bad.html"), true);
  assert.equal(samePath("/a/b/", "/a/b"), true);
  assert.equal(samePath("/docs/index.html", "/docs/"), true);
});

test("a genuinely different document is still caught", () => {
  // The faults this exists for: a redirect to another path, and the search-engine landing that recorded
  // 173 lines of Bing as evidence about a fixture.
  assert.equal(samePath("/search", "/route-title-stale/bad.html"), false);
  assert.equal(samePath("/skip-link-broken/good", "/skip-link-broken/bad"), false);
  assert.equal(samePath("/a/b", "/a/c"), false);
});
