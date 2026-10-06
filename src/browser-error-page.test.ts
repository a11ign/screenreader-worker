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
// FROM capture-pure, NOT capture-core: importing capture-core pulls guidepup, which constructs a
// ScreenReader at module scope and throws where none exists. On macOS VoiceOver satisfies it and the
// suite passes; on CI it does not. known-gaps §12, second occurrence.
import { isBrowserErrorTitle, pageServedRefusal, samePath } from "./capture-pure.mjs";

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

/**
 * THE STATUS CHECK IS THE TITLE CHECK'S SUCCESSOR, AND THE FIRST TEST BELOW IS WHY IT EXISTS.
 *
 * The guard above matches Chromium's error PHRASES. Chromium titles a network-error page with the HOST,
 * so an unserved `http://203.0.113.15:3000/x` is titled `203.0.113.15`, matches nothing, and the capture
 * comes back reading `"203.0.113.15, document, read only"` — a valid-looking document. That happened four
 * times in one session, twice AFTER the person hitting it had fixed it somewhere else.
 *
 * Both guards are kept. The title check fails fast on a phrase NVDA announces before anything else; the
 * status check is the authoritative answer and needs no phrase list to stay current. A guard built on a
 * proxy for the thing is exactly what this repo's oldest lesson warns about — but a proxy that costs
 * nothing and catches a case the direct measurement might miss is worth keeping beside it.
 */
test("the title guard CANNOT see the fault the status guard exists for", () => {
  // Not an invented example: this is the title of the page a real unserved capture returned.
  assert.equal(isBrowserErrorTitle("203.0.113.15"), false);
  assert.equal(isBrowserErrorTitle("localhost"), false);
  // And the status guard does see it.
  assert.match(String(pageServedRefusal("http://203.0.113.15:3000/x", { status: 0 })), /nothing is serving/);
});

test("a status outside 2xx is refused, and the message says which kind", () => {
  assert.match(String(pageServedRefusal("http://x/y", { status: 0 })), /no HTTP response at all/);
  assert.match(String(pageServedRefusal("http://x/y", { status: 404 })), /answered HTTP 404/);
  assert.match(String(pageServedRefusal("http://x/y", { status: 500 })), /answered HTTP 500/);
  // 0 and 404 are DIFFERENT answers and must not collapse: one means nothing is listening, the other
  // means something is and it does not have this page. The remedies are not the same.
  assert.notEqual(pageServedRefusal("http://x/y", { status: 0 }),
    pageServedRefusal("http://x/y", { status: 404 }));
});

test("every 2xx proceeds, including the ones nobody thinks about", () => {
  for (const status of [200, 201, 203, 204, 226, 299]) {
    assert.equal(pageServedRefusal("http://x/y", { status }), null, `HTTP ${status}`);
  }
});

test("UNCHECKED IS NOT BROKEN — an unanswerable status proceeds, and the caller marks it", () => {
  // A browser too old to report `responseStatus` must not become a permanently failing worker. This is
  // the same distinction `landedVerdict` draws for a null URL: silence from CDP is a different fault,
  // not a claim about the page.
  assert.equal(pageServedRefusal("http://x/y", null), null);
  assert.equal(pageServedRefusal("http://x/y", { status: null }), null);
});

test("chrome-error IS an answer, not a document to wait past — measured, not assumed", () => {
  // The dead-port capture on the fleet reports exactly this: the browser commits a real document at
  // `chrome-error://chromewebdata/` with `responseEnd: 2240.9` and `status: 0`. Excluding that URL the way
  // `about:` is excluded would make the guard wait out its budget and then decline to refuse — the
  // original defect restored, wearing the look of tidying up.
  assert.match(String(pageServedRefusal("http://127.0.0.1:59999/nothing", { status: 0 })),
    /no HTTP response at all/);
});
