// Chromium lists more targets than pages — service workers, extension backgrounds, the DevTools UI.
// Navigating the wrong one silently does nothing to the visible window, and the capture then reads the
// PREVIOUS page while every check passes. That is the evidence-rot failure mode this repo has hit
// before, so target selection is pure and tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePageTarget, reusableArgs, CDP_PORT, setExpectedPageUrl, expectedPageUrlForTest }
  from "./browser-session.mjs";

test("the visible page target is chosen", () => {
  const target = choosePageTarget([
    { type: "service_worker", url: "https://x/sw.js", webSocketDebuggerUrl: "ws://a" },
    { type: "page", url: "http://REDACTED-INTERNAL-ADDRESS:5050/case/good", webSocketDebuggerUrl: "ws://b" },
  ]);
  assert.equal(target?.webSocketDebuggerUrl, "ws://b");
  // No expectedUrl was given, so there was nothing to compare against -- distinct from "compared and
  // nothing matched", because the first reads as "this call ran before openPage set an expectation" and
  // the second reads as "every candidate is wrong", and those want different follow-up.
  assert.equal(target?.targetMatch, "no-expected-url");
});

// The defect this whole file exists to guard against: two unrelated real sites, bathingwaters.sepa.org.uk
// and lbhf.gov.uk/council-tax, returned a byte-identical census because a Cookiebot consent iframe
// surfaced its own `type: "page"` CDP target and the old `choosePageTarget` took the first one it saw,
// never checking its URL. See docs/backlog.md.

test("a second page-type target that matches the navigated URL is preferred over the first", () => {
  const target = choosePageTarget([
    { type: "page", url: "https://consent.cookiebot.com/what-is-behind-powered-by-cookiebot",
      webSocketDebuggerUrl: "ws://widget" },
    { type: "page", url: "https://bathingwaters.sepa.org.uk/", webSocketDebuggerUrl: "ws://real" },
  ], "https://bathingwaters.sepa.org.uk/");
  assert.equal(target?.webSocketDebuggerUrl, "ws://real");
  assert.equal(target?.targetMatch, "matched");
  assert.equal(target?.candidates, 2, "a matched target still reports how many candidates existed -- a "
    + "consumer trusts `matched` unconditionally, but the count travels for uniformity with fallback");
});

test("when NEITHER target matches, it falls back to the first usable one and SAYS SO", () => {
  // A redirect, a canonicalisation, or a page that has genuinely moved on since capture all look like
  // this. Silently returning null here would repeat the "census that measures nothing" defect this repo
  // has already paid for once (`fleet:status` "browserVersion" memo, `input.census` undefined on 3,790
  // captures) in a new place -- a fallback must be visible, never invisible.
  const target = choosePageTarget([
    { type: "page", url: "https://consent.cookiebot.com/some/other/path", webSocketDebuggerUrl: "ws://widget" },
    { type: "page", url: "https://example.com/unrelated", webSocketDebuggerUrl: "ws://other" },
  ], "https://bathingwaters.sepa.org.uk/");
  assert.equal(target?.webSocketDebuggerUrl, "ws://widget", "first usable target, same as pre-fix behaviour");
  assert.equal(target?.targetMatch, "fallback");
  assert.equal(target?.candidates, 2, "TWO real page-type targets competed and neither matched -- this is "
    + "the shape a wrong-document census actually needs; a consumer reading targetMatch alone cannot tell "
    + "this from the vacuous single-candidate case below");
});

test("a fallback with only ONE candidate is not the same finding as a fallback with two", () => {
  // The bathingwaters/lbhf contamination needed a SECOND page-type target (a Cookiebot widget) to pick
  // instead of the real page. With exactly one candidate, "fallback" and "the only correct answer" are the
  // same target -- a redirect or a URL the page server normalised, not a wrong document. `candidates` is
  // what lets a consumer (`docs/backlog.md`'s furniture-census row) tell the two apart; `targetMatch` alone
  // cannot, which is the whole reason it travels.
  const target = choosePageTarget([
    { type: "page", url: "https://ico.org.uk/action-weve-taken/enforcement-old-slug", webSocketDebuggerUrl: "ws://a" },
  ], "https://ico.org.uk/action-weve-taken/enforcement");
  assert.equal(target?.targetMatch, "fallback");
  assert.equal(target?.candidates, 1, "nothing else this fallback COULD have picked");
});

test("a trailing slash is not a different document", () => {
  const target = choosePageTarget([
    { type: "page", url: "https://ico.org.uk/action-weve-taken/enforcement", webSocketDebuggerUrl: "ws://a" },
  ], "https://ico.org.uk/action-weve-taken/enforcement/");
  assert.equal(target?.targetMatch, "matched");
});

test("host-vs-IP is not a different document -- every synthetic fixture looks exactly like this", () => {
  // case-matrix.mjs declares every fixture against localhost:5050; the lab serves it from whatever box
  // is running the capture, e.g. 203.0.113.79:5050. Requiring the host to match would tag EVERY synthetic
  // capture "fallback" for a reason that has nothing to do with a wrong document.
  const target = choosePageTarget([
    { type: "page", url: "http://203.0.113.79:5050/skip-link-broken/bad.html", webSocketDebuggerUrl: "ws://a" },
  ], "http://localhost:5050/skip-link-broken/bad.html");
  assert.equal(target?.targetMatch, "matched");
});

test("a requested .html and a landed extensionless path are the same document -- MEASURED, not hypothetical", () => {
  // Found 2026-09-05 diagnosing 2.4.7: every synthetic page is REQUESTED with `.html`
  // (case-matrix.mjs/openPage) and the page server serves the extensionless path, which is what CDP then
  // reports as the target's own url. Before `sameDocument` reused `samePath`, this tagged EVERY synthetic
  // capture ever taken "fallback" -- undetected because a single target still falls back onto the right
  // page, so no evidence was wrong, but the protection this file exists for was off the whole time.
  const target = choosePageTarget([
    { type: "page", url: "http://203.0.113.79:5050/focus-removed-on-receipt-coupon/bad",
      webSocketDebuggerUrl: "ws://a" },
  ], "http://203.0.113.79:5050/focus-removed-on-receipt-coupon/bad.html");
  assert.equal(target?.targetMatch, "matched");
});

test("a query string is part of the document identity, not ignored", () => {
  const targets = [
    { type: "page", url: "https://www.cqc.org.uk/search/all?query=other", webSocketDebuggerUrl: "ws://wrong" },
    { type: "page", url: "https://www.cqc.org.uk/search/all?query=hospital", webSocketDebuggerUrl: "ws://right" },
  ];
  const target = choosePageTarget(targets, "https://www.cqc.org.uk/search/all?query=hospital");
  assert.equal(target?.webSocketDebuggerUrl, "ws://right");
  assert.equal(target?.targetMatch, "matched");
});

// A worker is long-lived and serves many captures, so an expectation `setExpectedPageUrl` is never
// cleared is not an edge case, it is the normal state between requests. `pageTarget` itself does a real
// CDP fetch and cannot be unit-tested, so this asserts the state directly -- the way `expectedPageUrlForTest`
// exists for.

test("setExpectedPageUrl(null) clears the expectation, as captureWithNvda's finally now does on every capture", () => {
  setExpectedPageUrl("https://example.com/page-one");
  assert.equal(expectedPageUrlForTest(), "https://example.com/page-one");
  setExpectedPageUrl(null); // what captureWithNvda's finally block calls when a capture ends
  assert.equal(expectedPageUrlForTest(), null);
});

test("without the reset, a stale expectation would tag a same-path page on a DIFFERENT host as a false match", () => {
  // The exact failure the reset prevents: two unrelated pages sharing a path, captured back to back on a
  // worker that never cleared the previous capture's URL.
  setExpectedPageUrl("https://siteA.example.com/search");
  const staleTarget = choosePageTarget(
    [{ type: "page", url: "https://siteB.example.com/search", webSocketDebuggerUrl: "ws://b" }],
    expectedPageUrlForTest(),
  );
  assert.equal(staleTarget?.targetMatch, "matched", "path-only matching cannot see the host difference");
  setExpectedPageUrl(null); // the reset under test
  const target = choosePageTarget(
    [{ type: "page", url: "https://siteB.example.com/search", webSocketDebuggerUrl: "ws://b" }],
    expectedPageUrlForTest(),
  );
  assert.equal(target?.targetMatch, "no-expected-url",
    "cleared correctly: no stale expectation to falsely match against");
});

test("the DevTools UI is never chosen, even though it is type 'page'", () => {
  // devtools:// targets are pages by type. Navigating one would move the inspector, not the document.
  assert.equal(choosePageTarget([
    { type: "page", url: "devtools://devtools/bundled/inspector.html", webSocketDebuggerUrl: "ws://a" },
  ]), null);
});

test("a target with no websocket URL is unusable and skipped", () => {
  assert.equal(choosePageTarget([{ type: "page", url: "http://x" }]), null);
});

test("no targets, or a malformed list, yields null rather than throwing", () => {
  // The caller turns null into "launch a fresh browser", which is the safe direction.
  for (const bad of [[], null, undefined]) {
    assert.equal(choosePageTarget(bad as never), null);
  }
});

test("reusable args add ONLY the debugging port to the existing flags", () => {
  // Every other flag shapes what NVDA hears (--app suppresses browser chrome, the profile dir
  // suppresses the first-run experience). Changing any of them would confound an evidence comparison
  // between reused and fresh browsers, which is the whole point of gating this behind evidence:check.
  const base = ["--no-first-run", "--start-maximized", "--app=http://x/page"];
  const args = reusableArgs("http://x/page", base);
  assert.deepEqual(args.slice(0, base.length), base, "existing flags must be untouched and in order");
  assert.deepEqual(args.slice(base.length), [`--remote-debugging-port=${CDP_PORT}`]);
});

test("an ambiguous choice records WHICH targets were on offer, not just how many", () => {
  // A COUNT WITH NO IDENTITY STOPS AN INVESTIGATION RATHER THAN STARTING ONE, and this is the second time
  // that exact defect has been paid for here. `graphicUnnamed` was fixed the same way, by recording
  // `graphicUnnamedDetail` beside the number -- and it is what made the ONS 1.1.1 finding adjudicable in
  // one read instead of a live-site expedition.
  //
  // The instance: `rules:real-pages` reported 30 of 85 conformant real pages with a census it does not
  // trust, each saying `targetMatch: "fallback", candidates: 2` and NOTHING ELSE. Refusing the census on
  // that is right. Fixing it is impossible, because the whole question is WHICH second target Edge was
  // offering -- a consent vendor's iframe promoted to a page target, an `about:blank` the `--app` window
  // left behind, or the real page under a URL it normalised itself -- and those need three different
  // remedies.
  const target = choosePageTarget([
    { type: "page", url: "https://consent.example.com/banner", webSocketDebuggerUrl: "ws://a" },
    { type: "page", url: "https://caselaw.example.gov.uk/search?query=", webSocketDebuggerUrl: "ws://b" },
  ], "https://caselaw.example.gov.uk/nowhere");
  assert.equal(target?.targetMatch, "fallback");
  assert.equal(target?.candidates, 2);
  assert.deepEqual(target?.candidateUrls,
    ["https://consent.example.com/banner", "https://caselaw.example.gov.uk/search?query="],
    "a fallback must name the documents it was choosing between, in the order the browser offered them");
});

test("the recorded urls are BOUNDED, because this rides on every census of every capture", () => {
  const many = Array.from({ length: 9 }, (_, i) => (
    { type: "page", url: `https://example.com/${i}`, webSocketDebuggerUrl: `ws://${i}` }));
  const target = choosePageTarget(many, "https://example.com/nowhere");
  assert.equal(target?.candidates, 9, "the COUNT is never capped -- it is the cheap part and the alarm");
  assert.equal(target?.candidateUrls?.length, 4,
    "the urls are capped: four covers the measured worst case (2) with room, and a page with forty "
    + "targets is a different investigation");
});

