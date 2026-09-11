/**
 * #953: WHERE FOCUS SAT WHEN EACH SWEEP STARTED -- `focusInFrame`, the diagnostic #951's remedy waits on.
 *
 * #951 marks a sweep that found far less than the census and does not say why. The hypothesis
 * (worker-capture's, 2026-09-11; not yet a finding) is that a sweep landing on a focusable control inside a
 * chat widget's frame moves DOM focus into it, and NVDA's quick navigation is then held by that frame. No
 * capture records where focus was, so the corpus cannot test it. This row records it, and changes nothing a
 * capture does.
 *
 * Two halves, both tested here, because either alone could pass with nothing recorded:
 *   - the PAGE side: `focusFrame` in the DOM census every sweep already reads (`browser-session.mjs`), run the
 *     way the page receives it;
 *   - the RECORD side: `focusInFrameOf` (`capture-pure.mjs`), nested into the sweep's own `observed` entry at
 *     the one call site every sweep reaches (`collectByType`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { focusInFrameOf, sweepObservation } from "./capture-pure.mjs";
import { probeStates } from "@a11ign/evidence/verify";

const source = (file: string) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");

/**
 * The census expression AS THE PAGE RECEIVES IT. Not the source text with a couple of escapes undone:
 * the source is a template literal, and letting JS evaluate that literal is the only reading that applies
 * every escape the way module load does. A harness that undoes escapes by hand would pass on a slash the page
 * never sees.
 */
function pageExpression(): string {
  const match = source("browser-session.mjs").match(/const DOM_CENSUS_EXPRESSION = `([\s\S]*?)`;/);
  assert.ok(match, "the census expression must be findable BY NAME, or this test examines nothing");
  return new Function(`return \`${match[1]}\`;`)() as string;
}

type Node = { tagName: string, getAttribute: (k: string) => string | null, shadowRoot?: { activeElement: Node | null } };
const el = (tag: string, attrs: Record<string, string> = {}, shadowFocus?: Node | null): Node => ({
  tagName: tag.toUpperCase(),
  getAttribute: (k: string) => attrs[k] ?? null,
  ...(shadowFocus !== undefined ? { shadowRoot: { activeElement: shadowFocus } } : {}),
});

/** Run the census against a document whose focus is `active`. Every selector returns nothing: only focus is asked. */
function focusFrameWhen(active: Node | null | undefined): unknown {
  const document = {
    activeElement: active,
    documentElement: { getAttribute: () => null, closest: () => null },
    querySelectorAll: () => [],
  };
  const out = new Function("document", `return ${pageExpression()}`)(document) as Record<string, unknown>;
  assert.ok("focusFrame" in out, "the census must always ANSWER focusFrame -- absent would read as a worker predating it");
  return out.focusFrame;
}

test("#953 PAGE: focus inside a frame NAMES the frame; focus in the top document is null", () => {
  assert.equal(focusFrameWhen(el("iframe", { title: "Chat Widget" })), "Chat Widget");
  assert.equal(focusFrameWhen(el("iframe", { name: "hubspot-conversations" })), "hubspot-conversations");
  assert.equal(focusFrameWhen(el("frame", { id: "nav" })), "nav", "a <frame> holds focus the same way");
  assert.equal(focusFrameWhen(el("body")), null, "the top document");
  assert.equal(focusFrameWhen(el("button", { title: "Send" })), null, "a control in the top document, however it is named");
  assert.equal(focusFrameWhen(null), null, "no focused element at all");
});

test("#953 PAGE: an unnamed frame is found by its source's HOST, never its path or query", () => {
  const frame = el("iframe", { src: "https://app.hubspot.com/conversations-visitor/123/threads?token=secret#x" });
  assert.equal(focusFrameWhen(frame), "app.hubspot.com", "a path or query can carry a session token");
  assert.equal(focusFrameWhen(el("iframe", { src: "https://widget.example:8443/x" })), "widget.example");
  assert.equal(focusFrameWhen(el("iframe", { src: "/embedded/chat.html" })), "iframe", "a relative source has no host");
  assert.equal(focusFrameWhen(el("iframe")), "iframe", "a frame with nothing to name it by is still a frame");
});

test("#953 PAGE: a frame mounted in a SHADOW ROOT is still a frame -- the hypothesis must not be refuted by a wrapper", () => {
  // From the top document, focus inside a shadow root reads as the HOST. A widget that mounts its frame in
  // one would read as "top document", and that is the false refutation this follows the host to prevent.
  assert.equal(focusFrameWhen(el("div", {}, el("iframe", { title: "Messages" }))), "Messages");
  assert.equal(focusFrameWhen(el("div", {}, el("div", {}, el("iframe", { id: "deep" })))), "deep", "nested shadow roots");
  assert.equal(focusFrameWhen(el("div", {}, el("button"))), null, "a shadow host whose focus is a button, not a frame");
  assert.equal(focusFrameWhen(el("div", {}, null)), null, "a shadow host with nothing focused inside");
});

test("#953 RECORD: three answers -- the frame, null for the top document, and absent when nobody could say", () => {
  assert.deepEqual(focusInFrameOf({ focusFrame: "Chat Widget" }), { focusInFrame: "Chat Widget" });
  assert.deepEqual(focusInFrameOf({ focusFrame: null }), { focusInFrame: null }, "read, and focus was in the top document");
  assert.deepEqual(focusInFrameOf(null), {}, "the census failed: nobody could say, which is not 'not in a frame'");
  assert.deepEqual(focusInFrameOf({ heading: 3 } as never), {}, "a worker predating the field: absent, never null");
});

test("#953 RECORD: never a number, whatever the page returned", () => {
  for (const focusFrame of [3, 0, "", true, {}, ["x"]]) {
    const { focusInFrame } = focusInFrameOf({ focusFrame });
    assert.equal(focusInFrame, null, `${JSON.stringify(focusFrame)} is not a frame's name`);
  }
});

test("#953 NESTED under the sweep's own observed record, at the one call site every sweep reaches", () => {
  const record = { ...sweepObservation({ stop: "exhausted" }, { stop: "exhausted" }), ...focusInFrameOf({ focusFrame: "Chat Widget" }) };
  assert.deepEqual(Object.keys(record).sort(), ["asked", "complete", "focusInFrame", "stop"]);
  assert.equal(record.complete, true, "the sweep's own verdict is untouched");
  // Wired, not only defined: without this, every assertion above passes and no capture records anything.
  const probes = source("capture-probes.mjs");
  const start = probes.indexOf("async function collectByType(commands, ctx) {");
  assert.ok(start >= 0, "collectByType must be findable by name");
  const body = probes.slice(start, probes.indexOf("\n}\n", start));
  assert.match(body, /ctx\.observed\[ctx\.observedAs \?\? ctx\.label\] = \{ \.\.\.sweepObservation\(prevOutcome, nextOutcome\), \.\.\.focusInFrameOf\(scopeAt\) \}/,
    "the sweep's observed record carries focusInFrame, derived from the census read at that sweep's start");
  assert.equal((body.match(/domCensus\(|markPageState\(/g) ?? []).length, 1, "and from the ONE census read the sweep already takes");
  // No second home: the field lives in `observed[channel]` and nowhere at the capture's top level. The
  // worker only ever SETS it through the derivation above, never by name.
  assert.equal([...probes.matchAll(/\bfocusInFrame\s*[:=]/g)].length, 0,
    "capture-probes.mjs never assigns the field by name -- only the derivation that nests it");
});

test("#953: focus moving into a frame between probes is NOT the page changing", () => {
  // `focusFrame` lands on every `pageState` mark, and `probeStates` compares those marks to decide whether
  // the document changed mid-capture. It compares FINGERPRINT_KEYS by name, so a string beside them cannot
  // move the verdict -- asserted, because "a reader of every field" is the shape that turns a new field into
  // invented data.
  const fingerprint = { tabbable: 12, formField: 3, link: 40, landmark: 5, heading: 9, graphic: 7 };
  const { sameState, changed } = probeStates({
    diagnostics: [
      { event: "pageState", beforeProbe: "sweep:link", ...fingerprint, focusFrame: null },
      { event: "pageState", beforeProbe: "sweep:graphic", ...fingerprint, focusFrame: "Chat Widget" },
    ],
  } as never) ?? {};
  assert.equal(sameState, true);
  assert.equal(changed, undefined);
});
