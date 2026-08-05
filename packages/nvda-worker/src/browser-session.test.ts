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
