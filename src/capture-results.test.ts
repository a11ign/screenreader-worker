// The store exists so a lost RESPONSE does not destroy a finished capture. These assert the three
// distinctions it has to keep straight, because collapsing any of them recreates a fault this project has
// already paid for: "never heard of it" vs "still running", a failure's diagnosis vs a bare error, and
// bounded memory vs dropping a capture that is still in flight.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTHENTICATED_RESULT_TTL_MS, createResultStore, isValidCaptureId, RESULT_HISTORY, storedResultResponse,
} from "./capture-results.mjs";

test("a finished capture is replayed with its original status and body", () => {
  const store = createResultStore();
  store.begin("abc");
  store.finish("abc", { status: 200, body: { transcript: ["heading, level 1, City Library"] } });

  const entry = store.recall("abc");
  if (entry?.state !== "done") throw new Error(`expected a finished capture, got ${entry?.state ?? "nothing"}`);
  assert.equal(entry.status, 200);
  assert.deepEqual(entry.body, { transcript: ["heading, level 1, City Library"] });
});

test("a FAILED capture is kept too, so its fault code survives the lost socket", () => {
  // The point of the whole endpoint. The worker is the component that knows why a capture failed, and a
  // transport error replaces that diagnosis with "no answer" — which this project has repeatedly misread as
  // a dead machine. Recovering a 500 with its fault is worth as much as recovering a 200.
  const store = createResultStore();
  store.begin("f1");
  store.finish("f1", { status: 500, body: { error: "NVDA is running but not speaking", fault: "screen-reader-mute" } });

  const entry = store.recall("f1");
  if (entry?.state !== "done") throw new Error(`expected a finished capture, got ${entry?.state ?? "nothing"}`);
  assert.equal(entry.status, 500, "a replay must not launder a failure into a success");
  assert.equal((entry.body as { fault?: string }).fault, "screen-reader-mute");
});

test("'still running' and 'never heard of it' are different answers", () => {
  // They produce OPPOSITE correct actions: wait, versus re-issue the case. Every expensive fault in this
  // repo's history is two states reported as one.
  const store = createResultStore();
  store.begin("live");

  assert.equal(store.recall("live")?.state, "running");
  assert.equal(store.recall("never-started"), undefined);
});

test("the bound evicts finished captures but never a running one", () => {
  const store = createResultStore({ limit: 3 });
  store.begin("running-1");
  for (let i = 0; i < 10; i += 1) {
    store.begin(`done-${i}`);
    store.finish(`done-${i}`, { status: 200, body: { i } });
  }

  assert.equal(store.recall("running-1")?.state, "running",
    "evicting a live capture would lose the result at the moment this store was meant to protect it");
  assert.ok(store.size() <= 4, `bounded, got ${store.size()}`);
  // The most recent finished capture is the one most likely to be asked about.
  assert.equal(store.recall("done-9")?.state, "done");
});

test("the bound yields rather than dropping a live capture when everything is running", () => {
  const store = createResultStore({ limit: 2 });
  for (const id of ["a", "b", "c", "d"]) store.begin(id);
  assert.equal(store.size(), 4, "over the limit, deliberately — it self-corrects as captures finish");
  for (const id of ["a", "b", "c", "d"]) assert.equal(store.recall(id)?.state, "running");
});

test("a retry that reuses an id is the newest entry, not the oldest", () => {
  // Otherwise the reused id sits at the front of the eviction queue and is dropped first — the one entry
  // most likely to be asked about.
  const store = createResultStore({ limit: 2 });
  store.begin("x");
  store.finish("x", { status: 200, body: { first: true } });
  store.begin("y");
  store.finish("y", { status: 200, body: {} });
  store.begin("x");
  store.finish("x", { status: 200, body: { second: true } });
  store.begin("z");
  store.finish("z", { status: 200, body: {} });

  const retried = store.recall("x");
  if (retried?.state !== "done") throw new Error("the retry should have been recorded as finished");
  assert.deepEqual(retried.body, { second: true }, "the retry's result, not the first attempt's");
});

test("ids are validated at the boundary, because they reach us over the wire and go into a URL", () => {
  assert.equal(isValidCaptureId("9f8e7d6c-1234-4abc-9def-0123456789ab"), true, "a UUID must fit");
  assert.equal(isValidCaptureId("a"), true);
  assert.equal(isValidCaptureId(""), false);
  assert.equal(isValidCaptureId("../health"), false, "path traversal is the reason this check exists");
  assert.equal(isValidCaptureId("has space"), false);
  assert.equal(isValidCaptureId("x".repeat(65)), false);
  assert.equal(isValidCaptureId(undefined), false);
  assert.equal(isValidCaptureId(42), false);
});

test("an invalid id is ignored rather than stored under a key that can never be fetched", () => {
  const store = createResultStore();
  store.begin("bad id");
  store.finish("bad id", { status: 200, body: {} });
  assert.equal(store.size(), 0);
});

test("the default history is small on purpose", () => {
  // Recovery is worth attempting for seconds-to-minutes, not hours: after that the host has re-queued the
  // case anyway, and a long history only adds memory and the chance of answering with something stale.
  assert.ok(RESULT_HISTORY <= 16, `${RESULT_HISTORY} is more history than recovery can use`);
});

// The route's own decision, tested here because `server.mjs` needs guidepup — which refuses to import
// without a screen reader — and nothing inside it
// can be reached from a test. This is the endpoint's entire contract.

test("an unknown capture is 404, and a running one is 202 — never the same answer", () => {
  const store = createResultStore();
  store.begin("live");

  assert.equal(storedResultResponse(store.recall("nope"), "nope").status, 404,
    "404 tells the host to re-issue the case");
  assert.equal(storedResultResponse(store.recall("live"), "live").status, 202,
    "202 tells the host to wait — starting a second capture here is the waste this endpoint prevents");
});

test("a recovered capture replays the original status and body verbatim", () => {
  const store = createResultStore();
  store.begin("ok");
  store.finish("ok", { status: 200, body: { transcript: ["banner landmark, City Library"] } });
  assert.deepEqual(storedResultResponse(store.recall("ok"), "ok"),
    { status: 200, body: { transcript: ["banner landmark, City Library"] } });

  store.begin("bad");
  store.finish("bad", { status: 500, body: { error: "hard timeout", fault: "screen-reader-mute" } });
  const replayed = storedResultResponse(store.recall("bad"), "bad");
  assert.equal(replayed.status, 500, "a replay must be indistinguishable from the original response");
  assert.equal((replayed.body as { fault?: string }).fault, "screen-reader-mute");
});

test("a malformed id is refused before it is used as a key or echoed into a response", () => {
  const response = storedResultResponse(undefined, "../../health");
  assert.equal(response.status, 400);
  assert.ok(!JSON.stringify(response.body).includes(".."), "a rejected id must not be reflected back");
});

/**
 * 404 IS BOUNDED RESULT RECALL, NOT PROOF THE CAPTURE NEVER RAN — architecture-audit.md §14.4.
 *
 * The audit's own store probe, through the actual response-shaping function the route calls (not a bare
 * Map): a capture that DEFINITELY completed reads 404 the moment enough later captures evict it. "Re-issue
 * the case" is still the right recovery, but "never started" is not a claim this bounded, non-persisted
 * store can back up, and this repo's own docs used to make it anyway.
 */
test("an EVICTED capture reads 404 exactly like an id that never existed, though it definitely ran", () => {
  const store = createResultStore({ limit: 1 });
  store.begin("ran-and-finished");
  store.finish("ran-and-finished", { status: 200, body: { transcript: ["it really did run"] } });
  assert.equal(storedResultResponse(store.recall("ran-and-finished"), "ran-and-finished").status, 200,
    "still retained -- confirms the capture is really there before eviction");

  // One more finished capture, over the limit of 1, evicts the first.
  store.begin("later");
  store.finish("later", { status: 200, body: {} });

  const evicted = storedResultResponse(store.recall("ran-and-finished"), "ran-and-finished");
  assert.equal(evicted.status, 404,
    "eviction and 'never happened' must read identically at this boundary -- that IS the finding: 404 "
    + "cannot distinguish them, so callers may only conclude 'not retained here', never 'never ran'");
});

/**
 * REUSING AN ID SILENTLY EXECUTES AGAIN, WITH NO PAYLOAD-CONFLICT CHECK — architecture-audit.md §14.4.
 *
 * `begin(id)` unconditionally deletes any previous entry and starts fresh, whether the caller intended a
 * replay of the SAME request or accidentally reused an id for a DIFFERENT one. This is deliberately not
 * closed by fingerprinting the request (see the audit and this file's own header): documented here as the
 * real, current contract, not implemented against.
 */
test("begin() on an id with a RETAINED result discards it unconditionally -- no payload check exists", () => {
  const store = createResultStore();
  store.begin("reused");
  store.finish("reused", { status: 200, body: { url: "https://example.com/a" } });
  assert.equal(store.recall("reused")?.state, "done");

  // A caller reusing this id for a COMPLETELY DIFFERENT request -- nothing here can tell the two apart.
  store.begin("reused");
  assert.equal(store.recall("reused")?.state, "running",
    "the previous, unrelated result is gone the instant begin() is called again on the same id");
  store.finish("reused", { status: 200, body: { url: "https://example.com/completely-different-page" } });
  assert.equal((store.recall("reused") as { body?: { url?: string } })?.body?.url,
    "https://example.com/completely-different-page",
    "the second request's result silently replaced the first's -- reusing an id is the caller's contract "
    + "to keep, not something this store can enforce");
});

// ---- ADR 0038: an authenticated capture's response is held for ONE delivery, and no longer than its TTL ------------
//
// "`RESULT_HISTORY` never holds an authenticated transcript after it was delivered once" (the row's clause 9). The
// controls are the ordinary entries beside it: they must still be recalled as often as asked, or this would be a change
// to every capture's recovery and not to the authenticated one's.

test("AUTHENTICATED: a response recalled once is GONE; an ordinary one is recalled as many times as asked", () => {
  const store = createResultStore();
  store.begin("auth-1");
  store.finish("auth-1", { status: 200, body: { transcript: ["Dashboard"] } }, { deliverOnce: true });
  store.begin("plain-1");
  store.finish("plain-1", { status: 200, body: { transcript: ["Home"] } });

  const first = store.recall("auth-1");
  assert.equal(first?.state, "done");
  assert.deepEqual(first?.state === "done" ? first.body : null, { transcript: ["Dashboard"] }, "delivered once, in full");
  assert.equal(store.recall("auth-1"), undefined, "and then it is not held");
  assert.equal(store.size(), 1);
  assert.equal(store.recall("plain-1")?.state, "done");
  assert.equal(store.recall("plain-1")?.state, "done", "an ordinary response is still replayable");
});

test("AUTHENTICATED: a response nobody collects is dropped at its TTL, and never served after it", () => {
  const store = createResultStore();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    store.begin("auth-2");
    store.finish("auth-2", { status: 200, body: { transcript: ["Orders"] } }, { deliverOnce: true });
    now += AUTHENTICATED_RESULT_TTL_MS - 1;
    assert.equal(store.size(), 1, "still within its TTL");
    now += 2;
    assert.equal(store.recall("auth-2"), undefined, "expired: not served");
    assert.equal(store.size(), 0, "and not held");
    // Another capture arriving is also enough to sweep an expired one out.
    store.finish("auth-3", { status: 200, body: {} }, { deliverOnce: true });
    now += AUTHENTICATED_RESULT_TTL_MS + 1;
    store.begin("plain-2");
    assert.equal(store.size(), 1, "only the new entry remains");
  } finally { Date.now = realNow; }
});

test("AUTHENTICATED: evict removes a response the synchronous route has delivered; ordinary entries do not expire", () => {
  const store = createResultStore();
  store.begin("auth-4");
  store.finish("auth-4", { status: 200, body: {} }, { deliverOnce: true });
  store.evict("auth-4");
  assert.equal(store.recall("auth-4"), undefined);
  store.evict("not a valid id!"); // a malformed id reaches nothing
  const realNow = Date.now;
  const later = realNow() + AUTHENTICATED_RESULT_TTL_MS * 10;
  store.begin("plain-3");
  store.finish("plain-3", { status: 200, body: { kept: true } });
  Date.now = () => later;
  try { assert.equal(store.recall("plain-3")?.state, "done", "no TTL on an ordinary entry"); } finally { Date.now = realNow; }
});

test("AUTHENTICATED: a failed authenticated capture is held for one delivery too, fault code and all", () => {
  const store = createResultStore();
  store.begin("auth-5");
  store.finish("auth-5", { status: 500, body: { error: "the login did not complete", fault: "auth-login-failed" } }, { deliverOnce: true });
  const entry = store.recall("auth-5");
  if (entry?.state !== "done") throw new Error("expected a finished capture");
  assert.equal(entry.status, 500);
  assert.equal((entry.body as { fault: string }).fault, "auth-login-failed");
  assert.equal(store.recall("auth-5"), undefined);
});
