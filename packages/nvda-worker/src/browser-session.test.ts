// Chromium lists more targets than pages — service workers, extension backgrounds, the DevTools UI.
// Navigating the wrong one silently does nothing to the visible window, and the capture then reads the
// PREVIOUS page while every check passes. That is the evidence-rot failure mode this repo has hit
// before, so target selection is pure and tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePageTarget, reusableArgs, CDP_PORT } from "./browser-session.mjs";

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
});

test("a trailing slash is not a different document", () => {
  const target = choosePageTarget([
    { type: "page", url: "https://ico.org.uk/action-weve-taken/enforcement", webSocketDebuggerUrl: "ws://a" },
  ], "https://ico.org.uk/action-weve-taken/enforcement/");
  assert.equal(target?.targetMatch, "matched");
});

test("host-vs-IP is not a different document -- every synthetic fixture looks exactly like this", () => {
  // case-matrix.mjs declares every fixture against localhost:5050; the lab serves it from whatever box
  // is running the capture, e.g. REDACTED-INTERNAL-ADDRESS:5050. Requiring the host to match would tag EVERY synthetic
  // capture "fallback" for a reason that has nothing to do with a wrong document.
  const target = choosePageTarget([
    { type: "page", url: "http://REDACTED-INTERNAL-ADDRESS:5050/skip-link-broken/bad.html", webSocketDebuggerUrl: "ws://a" },
  ], "http://localhost:5050/skip-link-broken/bad.html");
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
