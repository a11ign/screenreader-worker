/**
 * The browser must be showing the page we asked for — checked by POLLING, not by looking once.
 *
 * ## The defect this exists to stop recurring
 *
 * The first version read the URL exactly once, immediately after `openPage`. `browserReady` only means
 * `browserAlive()` returned true, and that proves **the DevTools port answers** — not that the requested
 * URL has loaded. So after a browser recycle the read landed on the previous document while the new
 * navigation was still in flight, and the capture was failed.
 *
 * Measured 2026-08-25, from the diagnostics of five failed captures on one worker:
 *
 *     browserClosed  atMs 8153  forced: true
 *     browserReady   atMs 8163
 *     landedOnRequested atMs 8164  ok: false     <- ONE MILLISECOND later
 *
 * Every one followed `browserRecycle after: 25`, and the reported `actual` URL was a real page the server
 * was serving at that moment. Nothing was unreachable. The check looked too early.
 *
 * That is CLAUDE.md's longest lesson committed in a new place: *"a condition must be sufficient —
 * `screenReaderResponds()` only proves the Remote port accepts a TCP connection, not that NVDA's virtual
 * buffer is navigable."* `browserAlive()` is the same insufficient condition one subsystem over.
 *
 * ## Why injection rather than a browser
 *
 * The entire defect is about WHEN the URL is read, so a test that cannot control time cannot see it.
 * `landedVerdict` takes its reader, its clock and its sleep, exactly as `file-version-memo.test.ts` drives
 * an injected `stat`/`read` to test Windows behaviour off Windows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// capture-pure, not capture-core — see known-gaps §12: capture-core imports guidepup, which throws at
// module scope on any host without a screen reader, so this file died on CI while passing on a Mac.
import { addressesSamePage, landedVerdict } from "./capture-pure.mjs";

const PAGE = "http://203.0.113.79:5050/link-vague-ferry/good.html";
const OTHER = "http://203.0.113.79:5050/image-filename-alt-exhibit/bad";

/** A clock and a sleep that advance together, so a 30 s budget costs no real time. */
function fakeClock() {
  let t = 0;
  return { now: () => t, wait: async (ms: number) => { t += ms; } };
}

/** Reads that answer in sequence, then repeat the last one for ever. */
const reader = (answers: (string | null)[]) => {
  let i = 0;
  return async () => answers[Math.min(i++, answers.length - 1)];
};

test("a page that is already right matches on the FIRST read and waits not at all", () => {
  // The common case must cost nothing, or a guard that fixes a rare fault taxes every capture.
  const clock = fakeClock();
  return landedVerdict(PAGE, { read: reader([PAGE]), ...clock }).then((v) => {
    assert.equal(v.ok, true);
    assert.equal(v.attempts, 1);
    assert.equal(v.waitedMs, 0);
  });
});

test("REPRODUCES THE FAULT: a navigation still in flight is waited for, not failed", async () => {
  // Three reads of the previous document, then the right one. The one-shot version failed on read #1 and
  // that is precisely what cost five captures.
  const clock = fakeClock();
  const verdict = await landedVerdict(PAGE, { read: reader([OTHER, OTHER, OTHER, PAGE]), ...clock });
  assert.equal(verdict.ok, true, "a page that arrives late must pass, not fail");
  assert.equal(verdict.attempts, 4);
  assert.ok(verdict.waitedMs > 0, "and the wait must be recorded, so it is visible that it happened");
});

test("a page that never arrives is still a FAILURE once the budget is spent", async () => {
  // The guard must not become decoration. It exists because Edge once treated an address as a Bing search
  // and that was recorded as evidence about the fixture.
  const clock = fakeClock();
  const verdict = await landedVerdict(PAGE, { read: reader([OTHER]), budgetMs: 5_000, ...clock });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.actual, OTHER);
  assert.ok(verdict.attempts > 1, "it must have polled rather than given up on the first read");
});

test("the budget is honoured rather than looping for ever", async () => {
  const clock = fakeClock();
  const verdict = await landedVerdict(PAGE, { read: reader([OTHER]), budgetMs: 1_000, pollMs: 100, ...clock });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.waitedMs >= 1_000 && verdict.waitedMs < 1_500, `waited ${verdict.waitedMs}ms`);
});

test("a URL that cannot be read at all makes NO claim, and is retried first", async () => {
  // `currentPageUrl` returns null when CDP is unreachable, which is a different fault reported elsewhere.
  // Treating it as "the page is wrong" would be the same conflation FAULT.WRONG_PAGE was split to remove.
  // It is also transient right after a launch, so it must be polled through rather than taken as a verdict.
  const clock = fakeClock();
  const recovered = await landedVerdict(PAGE, { read: reader([null, null, PAGE]), ...clock });
  assert.equal(recovered.ok, true, "a transient CDP silence must not fail the capture");

  const silent = await landedVerdict(PAGE, { read: reader([null]), budgetMs: 2_000, ...clock });
  assert.equal(silent.ok, false);
  assert.equal(silent.actual, null, "with no URL read, the caller must be able to tell it made no claim");
});

test("the comparison is by origin and PATH, ignoring what a server may add", () => {
  // A trailing slash, a `.html` extension, a query string or a fragment are all things a server or a site
  // may legitimately add. Failing a capture for one would be a guard that cries wolf.
  assert.equal(addressesSamePage("http://h:5050/a/good.html", "http://h:5050/a/good"), true);
  assert.equal(addressesSamePage("http://h:5050/a/good/", "http://h:5050/a/good.html"), true);
  assert.equal(addressesSamePage("http://h:5050/a/good?x=1#y", "http://h:5050/a/good.html"), true);
  // A different host or path is exactly what it must catch — the Bing redirect that started this.
  assert.equal(addressesSamePage("https://www.bing.com/search?q=localhost", "http://h:5050/a/good"), false);
  assert.equal(addressesSamePage("http://h:5050/b/bad", "http://h:5050/a/good"), false);
  // `about:blank` PARSES, so it is a real reading and the honest answer is false — the browser is
  // definitively not on the requested page. My first version of this test asserted null and was wrong
  // about the code rather than the other way round. It matters that this is `false`: `about:blank` is the
  // ordinary state a browser is in for a moment after launch, and `false` is what the poll retries
  // through. Returning null would make the guard silently give up on the most common transient there is.
  assert.equal(addressesSamePage("about:blank", "http://h:5050/a/good"), false);
  // A string that is not a URL at all makes no claim either way.
  assert.equal(addressesSamePage("not a url", "http://h:5050/a/good"), null);
});

test("about:blank right after launch is polled THROUGH, not failed", async () => {
  // The exact transient the recycle produces, end to end.
  const clock = fakeClock();
  const verdict = await landedVerdict(PAGE, { read: reader(["about:blank", OTHER, PAGE]), ...clock });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.attempts, 3);
});
