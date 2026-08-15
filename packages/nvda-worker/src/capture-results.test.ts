// The store exists so a lost RESPONSE does not destroy a finished capture. These assert the three
// distinctions it has to keep straight, because collapsing any of them recreates a fault this project has
// already paid for: "never heard of it" vs "still running", a failure's diagnosis vs a bare error, and
// bounded memory vs dropping a capture that is still in flight.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createResultStore, isValidCaptureId, RESULT_HISTORY, storedResultResponse,
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

// The route's own decision, tested here because `server.mjs` binds a port on import and nothing inside it
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
