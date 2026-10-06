/**
 * #2587 (#2550 half 2): the focus-event log records what ALREADY held focus when its listener attached.
 *
 * A v21 log opens on whatever the page does next, so a control that held focus first (a cookie-consent
 * widget, on 8 of 100 protocol-21 real pages) surfaces as a bare `focusout` the 2.4.7 rule can only call
 * `unpairable`. The install now pushes `document.activeElement` as the log's first entry, `initial: true`.
 *
 * WHICH HALF THIS PROVES: the install expression, run against a fake `document`/`window`, produces the
 * entry and leaves the body-focus log byte-identical. It does NOT prove what a real Edge reports as
 * `activeElement` at the moment of install on a real page: that needs a capture, and is the recapture's
 * reading (`npm run corpus:focus-log-first-event` at protocol 22), routed to `orchestrator` on the row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { INSTALL_FOCUS_EVENT_LOG_EXPRESSION } from "./browser-session.mjs";

type FakeElement = { tagName: string; id?: string; getAttribute: (name: string) => string | null };
type Entry = { type: string; id: number; name: string; atMs: number; initial?: true };
type Page = { window: { __a11yFocusLog?: Entry[]; __a11yFocusIn?: (e: unknown) => void }; result: unknown };

const element = (tagName: string, label: string | null = null): FakeElement =>
  ({ tagName, getAttribute: (name) => (name === "aria-label" ? label : null) });

/** Run the REAL install expression with `active` holding focus. */
function install(active: unknown, body: unknown, documentElement: unknown): Page {
  const window: Page["window"] = {};
  const document = { activeElement: active, body, documentElement, addEventListener: () => {} };
  const result = new Function("window", "document", "performance", `return ${INSTALL_FOCUS_EVENT_LOG_EXPRESSION}`)(
    window, document, { now: () => 1234 });
  return { window, result };
}

const body = element("BODY");
const root = element("HTML");

test("#2587: an element already holding focus is the log's first entry, marked initial", () => {
  const consent = element("BUTTON", "Accept cookies");
  const { window, result } = install(consent, body, root);
  assert.deepEqual(result, { installed: true });
  assert.deepEqual(window.__a11yFocusLog, [
    { type: "focusin", id: 0, name: "Accept cookies", atMs: 0, initial: true },
  ]);
});

test("#2587: the initial entry's id comes from the SAME map as later events, so a later event on it re-uses id 0", () => {
  const consent = element("BUTTON", "Accept cookies");
  const { window } = install(consent, body, root);
  window.__a11yFocusIn?.({ target: consent });
  const [initial, later] = window.__a11yFocusLog as Entry[];
  assert.equal(later.id, initial.id, "identity, not name, is the join key");
  assert.equal(later.initial, undefined, "a witnessed event carries no marker");
});

test("#2587: focus resting on the body (or the root, or nothing) pushes nothing -- the log is byte-identical to protocol 21's", () => {
  for (const active of [body, root, null]) {
    assert.deepEqual(install(active, body, root).window.__a11yFocusLog, [],
      `activeElement ${active === null ? "null" : (active as FakeElement).tagName} must leave the log empty`);
  }
});
