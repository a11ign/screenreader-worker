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
import { isBrowserErrorTitle } from "./capture-core.mjs";

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
