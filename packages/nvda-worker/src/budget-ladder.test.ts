/**
 * The budget ladder, asserted rather than assumed.
 *
 * A capture nests inside three deadlines defined in three different files, and nobody had checked they were
 * ordered. The capture budget was 120 s inside a worker hard timeout of 240 s — so captures were cut off
 * less than half way to the limit their own worker tolerated, and the phases that run last lost their
 * evidence. That failure is silent: the capture still returns 200 with a transcript, just without the
 * interaction probes that carry 3.3.1 and 4.1.3.
 *
 * Measured on the W3C survey page, which is where the numbers come from:
 *
 *   read-through      61 s   (89 lines, completed naturally with stopReason `repeatBottom`)
 *   heading+landmark   8 s
 *   formField         43 s   (16 fields, activating controls)
 *   link/list/postSubmit  starved — each returned `deadline` having examined nothing
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  budgetLadderIsSound,
  CAPTURE_HARD_TIMEOUT_DEFAULT_MS,
  DEFAULT_BUDGET_MS,
  POST_READ_RESERVE_MS,
  readThroughDeadline,
  WORST_CASE_STARTUP_MS,
} from "./capture-pure.mjs";

/**
 * The host's per-capture timeout, READ from the file that owns it rather than copied here.
 *
 * A hardcoded copy would keep asserting the old number after somebody lowered the real one, so the ladder
 * would look sound while the outermost rung had moved underneath it — the same silent-drift failure the
 * ladder exists to prevent, reintroduced by its own test. Static parse rather than an import, because that
 * module is a script: `pure-graph.test.ts` sets the precedent for checking a source file by reading it.
 */
const HOST_TIMEOUT_MS = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    join(here, "..", "..", "lab", "src", "training", "capture-screenreader-dataset.mjs"), "utf8");
  const match = src.match(/DATASET_CAPTURE_TIMEOUT_MS\s*\|\|\s*(\d+)/);
  if (!match) throw new Error("could not read the host capture timeout — has that constant been renamed?");
  return Number(match[1]);
})();

test("the ladder the shipped constants form is ordered", () => {
  // The whole point. If this fails, some edit has made a capture's own budget exceed what contains it,
  // and the symptom will be truncated evidence rather than an error.
  assert.ok(budgetLadderIsSound({
    budgetMs: DEFAULT_BUDGET_MS,
    hardTimeoutMs: CAPTURE_HARD_TIMEOUT_DEFAULT_MS,
    hostTimeoutMs: HOST_TIMEOUT_MS,
    startupMs: WORST_CASE_STARTUP_MS,
  }), `budget ${DEFAULT_BUDGET_MS} + startup ${WORST_CASE_STARTUP_MS} must fit inside `
    + `hard timeout ${CAPTURE_HARD_TIMEOUT_DEFAULT_MS}, which must fit inside host ${HOST_TIMEOUT_MS}`);
});

test("startup is counted against the hard timeout, because the budget excludes it", () => {
  // The subtlety that makes the arithmetic non-obvious: the capture deadline is taken AFTER NVDA is up, so
  // a cold start (measured at 44 s, once including an NVDA restart) is invisible to the budget and fully
  // visible to the hard timeout. Ignoring it is how a "safe" budget trips the timeout on a cold guest.
  assert.ok(DEFAULT_BUDGET_MS + WORST_CASE_STARTUP_MS < CAPTURE_HARD_TIMEOUT_DEFAULT_MS);
  // And the naive check that omits startup must not be what we rely on: prove it would pass a bad ladder.
  //
  // DERIVED from the shipped hard timeout rather than hardcoded. The previous version used a literal 270_000,
  // chosen to be unsafe against a 280_000 hard timeout — so raising the hard timeout for real pages made that
  // budget safe and this assertion failed for a reason that had nothing to do with the property under test. A
  // test whose fixture is pinned to a constant it does not own goes stale the moment the constant moves.
  const unsafeBudget = CAPTURE_HARD_TIMEOUT_DEFAULT_MS - Math.floor(WORST_CASE_STARTUP_MS / 5);
  assert.ok(unsafeBudget + WORST_CASE_STARTUP_MS > CAPTURE_HARD_TIMEOUT_DEFAULT_MS
    && unsafeBudget < CAPTURE_HARD_TIMEOUT_DEFAULT_MS,
    "the fixture must be a budget that fits WITHOUT startup and overflows WITH it, or it tests nothing");
  assert.ok(budgetLadderIsSound({
    budgetMs: unsafeBudget, hardTimeoutMs: CAPTURE_HARD_TIMEOUT_DEFAULT_MS, hostTimeoutMs: HOST_TIMEOUT_MS,
    startupMs: 0,
  }), "with startup ignored, an unsafe budget looks fine — which is why startupMs is a parameter");
  assert.equal(budgetLadderIsSound({
    budgetMs: unsafeBudget, hardTimeoutMs: CAPTURE_HARD_TIMEOUT_DEFAULT_MS, hostTimeoutMs: HOST_TIMEOUT_MS,
    startupMs: WORST_CASE_STARTUP_MS,
  }), false, "and why the real check refuses it");
});

test("an inverted ladder is REFUSED, so the guard is known to fire", () => {
  // The exact configuration that shipped: a budget larger than the hard timeout containing it.
  assert.equal(budgetLadderIsSound({
    budgetMs: 300_000, hardTimeoutMs: 240_000, hostTimeoutMs: 300_000, startupMs: 0,
  }), false);
  // A hard timeout the host gives up before is equally broken, from the other end.
  assert.equal(budgetLadderIsSound({
    budgetMs: 60_000, hardTimeoutMs: 400_000, hostTimeoutMs: 300_000, startupMs: 0,
  }), false);
  // And a reserve that does not fit inside the budget would starve the read-through completely.
  assert.equal(budgetLadderIsSound({
    budgetMs: 30_000, hardTimeoutMs: 240_000, hostTimeoutMs: 300_000, startupMs: 0,
  }), false, "the reserve must be smaller than the budget it is carved out of");
});

test("the read-through stops early, leaving the reserve for the phases after it", () => {
  const now = 1_000_000;
  const captureDeadline = now + DEFAULT_BUDGET_MS;
  assert.equal(captureDeadline - readThroughDeadline(captureDeadline, now), POST_READ_RESERVE_MS);
});

test("a small budget scales the reserve down instead of reading nothing", () => {
  // `capture-check` and the unit paths pass short budgets. Subtracting a fixed 60 s from a 10 s budget
  // would put the read deadline in the past, so the read-through would return an empty transcript — which
  // this pipeline reports as "the page announced nothing", the signature of a real failure.
  const now = 1_000_000;
  assert.equal(readThroughDeadline(now + 10_000, now) - now, 5_000, "half of what is left");
  assert.equal(readThroughDeadline(now + 2_000, now) - now, 1_000);
});

test("an already-expired budget is returned unchanged, not pushed further into the past", () => {
  const now = 1_000_000;
  assert.equal(readThroughDeadline(now - 5_000, now), now - 5_000);
  assert.equal(readThroughDeadline(now, now), now);
});

test("the reserve is big enough for the phases it protects", () => {
  // Measured: link 3.6 s + list 3.6 s + postSubmit 4.9 s on the page that starved, and the formField sweep
  // reached 43 s on the same page. The reserve cannot guarantee a huge formField sweep AND the tail, so it
  // is sized for the tail — the part nothing else can produce evidence for.
  const measuredTailMs = 3_600 + 3_600 + 4_900;
  assert.ok(POST_READ_RESERVE_MS > measuredTailMs * 4,
    "the reserve should carry the measured tail several times over, since pages vary");
});

/**
 * The ladder above is arithmetic over constants. This asserts the constants are the ones that actually
 * APPLY -- which they were not.
 *
 * Node's global `fetch` is undici, and undici stops waiting for response HEADERS after 300 s independently
 * of any `AbortSignal`. So while the capture clients used `fetch`, the real outermost rung was 300 s: it sat
 * BELOW the worker's own 520 s hard timeout, and every constant this file checks was decorative above it.
 * The ladder test passed throughout, because a rung it does not know about is a rung it cannot measure.
 *
 * Measured on Node v24.7.0 against a server that withheld headers for 310 s: global fetch threw
 * UND_ERR_HEADERS_TIMEOUT with a 560 s AbortSignal; the same request over `node:http` returned 200.
 *
 * The rule is not "never use fetch" -- `pageTitle` fetches a dataset page on a 15 s budget and is fine.
 * It is that a budget which can EXCEED undici's cap must not be expressed as an AbortSignal, because there
 * the number is simply ignored and the failure looks like a dead worker.
 *
 * Grepping the source is crude, but the alternative is a 300-second test.
 */
const UNDICI_HEADERS_CAP_MS = 300_000;

/**
 * Every capture client, DISCOVERED rather than listed.
 *
 * The previous version of this guard named three files. Seven others posted captures and it could not
 * see any of them -- including `occurrence-verdict-stability.mjs`, which declared 560 s and got 300 s,
 * the exact defect this guard was written for. A hardcoded list is a guard that only checks the places
 * somebody already thought of, which is the same shape as the worker-file list that let a file deploy
 * invisibly.
 */
function captureClients(): Array<[string, string]> {
  const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const found: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // `dist` is build output of the very files we are checking, so including it double-counts and
      // reports a stale copy as a violation after the source has been fixed.
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(path);
      } else if (/\.(mjs|ts)$/.test(entry.name) && !entry.name.includes(".test.")) {
        const src = readFileSync(path, "utf8");
        // The worker SERVES this route; it is not a client of it.
        if (path.endsWith("server.mjs")) continue;
        if (/\/capture\b/.test(src) && /method:\s*["']POST["']/.test(src)) {
          found.push([path.slice(packages.length + 1), src]);
        }
      }
    }
  };
  walk(packages);
  return found;
}

test("no capture client declares a budget that undici will silently ignore", () => {
  const clients = captureClients();

  // A discovery that finds nothing would pass every assertion below in perfect silence -- this repo's
  // own rule about checks that report success having examined nothing. Ten clients exist today.
  assert.ok(clients.length >= 8,
    `only found ${clients.length} capture clients; the discovery walk is broken, not the codebase clean`);

  for (const [name, src] of clients) {
    assert.match(src, /requestJson/,
      `${name} must post captures through requestJson (worker-http.mjs), which has no headers cap`);

    for (const [, argument] of src.matchAll(/AbortSignal\.timeout\(\s*([A-Za-z0-9_]+)\s*\)/g)) {
      const ms = resolveMs(src, argument);
      if (ms === null) {
        assert.fail(
          `${name} passes ${argument} to AbortSignal.timeout() and this test cannot resolve it to a number. `
          + `Either inline the value or route the request through requestJson — an unresolvable budget is how `
          + `a 300 s ceiling hid behind a 560 s constant.`);
      }
      assert.ok(ms < UNDICI_HEADERS_CAP_MS,
        `${name} declares a ${ms} ms budget via AbortSignal.timeout(), but undici stops waiting for response `
        + `headers at ${UNDICI_HEADERS_CAP_MS} ms whatever the signal says. Use requestJson (worker-http.mjs).`);
    }
  }
});

/**
 * Every client's ceiling must sit ABOVE the worker's own hard timeout, not just below undici's cap.
 *
 * The ladder test above reads ONE hardcoded path, `capture-screenreader-dataset.mjs`, so it could not see
 * that `capture-real-pages.mjs` capped at 300 s against a 520 s hard timeout -- inverted, on the client that
 * captures REAL pages, which are the pages most likely to need the full budget. A real page that used its
 * budget was killed by the host before the worker's own backstop and dropped with no retry, so the corpus
 * was silently biased toward small simple pages: exactly the axis the real-page corpus exists to add.
 *
 * The undici check in the test above and this one look similar and are not: that one is about a ceiling the
 * transport imposes regardless of what you asked for, this one is about asking for less than the thing you
 * are waiting on can take. A client can satisfy either and violate the other.
 *
 * Matches `timeoutMs:` as well as `AbortSignal.timeout(...)`, because the offending client used the former
 * and neither existing pattern looked for it.
 */
test("the shared client ceiling sits above the worker's hard timeout", () => {
  // Read from source, not imported, for the same reason the ladder above reads its host rung from source:
  // a hardcoded copy here would keep asserting the old number after somebody lowered the real one.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "..", "worker-fleet", "src", "worker-http.mjs"), "utf8");
  const declared = src.match(/CAPTURE_CLIENT_TIMEOUT_MS\s*=\s*([\d_]+)/);
  assert.ok(declared, "CAPTURE_CLIENT_TIMEOUT_MS is gone from worker-http.mjs — has it been renamed?");
  const ms = Number(declared[1].replace(/_/g, ""));
  assert.ok(ms > CAPTURE_HARD_TIMEOUT_DEFAULT_MS,
    `clients wait ${ms} ms but the worker's hard timeout is ${CAPTURE_HARD_TIMEOUT_DEFAULT_MS} ms. The `
    + `client would give up first, so a capture that used its budget is reported as a client failure.`);
});

/**
 * No client may declare its OWN capture ceiling below the worker's hard timeout.
 *
 * The ladder test at the top reads ONE hardcoded path, so it could not see that seven clients capped at
 * 300-320 s against a 520 s hard timeout: `compare-workers`, `bench-capture`, `evidence-check`,
 * `repeat-capture`, `capture-real-pages`, `capture-check` and `page-identity-rate`. The client gave up
 * first, so a capture the worker would have finished was reported as a client failure and dropped.
 *
 * On the generated corpus nothing noticed -- a 1,338-byte page finishes in seconds. On REAL pages it
 * silently discarded whatever used its budget, biasing the real-page corpus toward small simple pages:
 * exactly the axis that corpus exists to add.
 *
 * This is a DIFFERENT check from the undici one above. That is about a ceiling the transport imposes
 * whatever you ask for; this is about asking for less than the thing you are waiting on can take. A client
 * can satisfy either and violate the other, which is how these seven passed for so long.
 *
 * Matches `timeoutMs:` as well as `AbortSignal.timeout(...)`, because every one of the seven used the
 * former and neither existing pattern looked for it.
 */
test("no capture client declares its own ceiling below the worker's hard timeout", () => {
  const clients = captureClients();
  assert.ok(clients.length >= 8, `only found ${clients.length} capture clients; the discovery walk is broken`);

  for (const [name, src] of clients) {
    for (const [, argument] of src.matchAll(/(?:timeoutMs:\s*|AbortSignal\.timeout\(\s*)([A-Za-z0-9_]+)/g)) {
      // Unresolvable means it comes from the shared constant, asserted above. A short page fetch is not a
      // capture ceiling, so anything under half the hard timeout is out of scope for this check.
      const ms = resolveMs(src, argument);
      if (ms === null || ms < CAPTURE_HARD_TIMEOUT_DEFAULT_MS / 2) continue;
      assert.ok(ms > CAPTURE_HARD_TIMEOUT_DEFAULT_MS,
        `${name} declares its own ${ms} ms capture ceiling, below the worker's `
        + `${CAPTURE_HARD_TIMEOUT_DEFAULT_MS} ms hard timeout. Import CAPTURE_CLIENT_TIMEOUT_MS from `
        + `worker-http.mjs instead of declaring a local one.`);
    }
  }
});

/** A literal, or a `const NAME = <number>` / `Number(process.env.X || <number>)` in the same file. */
function resolveMs(src: string, argument: string): number | null {
  // `15_000` is a literal too. Without the separator strip this fell through to the identifier branch,
  // failed to resolve, and reported a perfectly good 15 s page fetch as an unresolvable budget — a guard
  // that cries wolf gets deleted, which is worse than one that never fired.
  if (/^\d[\d_]*$/.test(argument)) return Number(argument.replace(/_/g, ""));
  const declared = src.match(new RegExp(`const\\s+${argument}\\s*=\\s*([^;]+);`));
  if (!declared) return null;
  const literal = declared[1].replace(/_/g, "").match(/(\d+)\s*\)?\s*$/);
  return literal ? Number(literal[1]) : null;
}
