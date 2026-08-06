/**
 * The `busy` slot must be claimed in the SAME synchronous step as the check.
 *
 * NVDA is one machine-wide resource, so two captures cannot overlap. The worker refuses a second with 429 —
 * but the check and the claim used to be separated by an `await` boundary: `busy` was tested when the request
 * arrived and set later, inside the capture, after the request body had been read.
 *
 * Node does not preempt mid-statement, so a synchronous check-then-set is atomic. A check and a set separated
 * by an await are not: two requests arriving close together both saw `busy === false`, both read their bodies,
 * and both drove the same screen reader. **That does not fail loudly.** It produces two captures interleaved on
 * one NVDA — contaminated evidence, not an error — and nothing downstream could tell.
 *
 * Reachable despite the pool sending one case per worker at a time: CLAUDE.md records that two shells or two
 * agents drive this worker, and a `--no-cache` rerun beside a live run is exactly that shape.
 *
 * `server.mjs` binds a port on import and needs Windows, so this asserts the ORDERING PROPERTY against the
 * source, and separately proves the property itself with a model of both arrangements. Found by applying Clean
 * Code's Concurrency chapter, which the review skill was missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const server = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");

test("the busy check and the busy claim are in one synchronous step", () => {
  const accept = /function acceptCaptureRequest\([\s\S]*?\n}/.exec(server)?.[0];
  assert.ok(accept, "acceptCaptureRequest not found; this scan is broken, not passing");

  const check = accept.indexOf("if (busy)");
  const claim = accept.indexOf("busy = true");
  assert.ok(check >= 0, "the 429 refusal should live in acceptCaptureRequest");
  assert.ok(claim >= 0, "the claim must happen in acceptCaptureRequest, not after an await in the capture");
  assert.ok(claim > check, "the claim must follow the check");

  // Nothing may await between them. `req.on(...)` registering a callback is the boundary that broke this.
  const between = accept.slice(check, claim);
  assert.doesNotMatch(between, /await|req\.on\(/,
    `an await boundary between the check and the claim reopens the race: ${JSON.stringify(between)}`);
});

test("every path out of the request releases the slot", () => {
  const accept = /function acceptCaptureRequest\([\s\S]*?\n}/.exec(server)?.[0] ?? "";
  // The two validation rejections happen after the claim, so each must hand the slot back or the worker wedges:
  // ready, answering /health, and 429ing every capture forever.
  for (const rejection of ["invalid JSON body", "url is required"]) {
    const line = accept.split("\n").find((l) => l.includes(rejection)) ?? "";
    assert.match(line, /busy = false/,
      `the "${rejection}" rejection must release the slot it claimed`);
  }
  // And a request that dies before `end` never reaches those lines at all.
  assert.match(server, /function releaseOnAbandon/,
    "a request abandoned mid-body would hold the slot forever with no capture to time out");
});

test("the ordering actually decides the outcome", async () => {
  // The property under test, modelled: two requests arriving while the first is still reading its body. This is
  // what makes the source assertions above meaningful rather than stylistic.
  const arrive = async (claimEarly: boolean, state: { busy: boolean; started: number }) => {
    if (state.busy) return "429";
    if (claimEarly) state.busy = true;
    await Promise.resolve();          // the body-read boundary
    if (!claimEarly) state.busy = true;
    state.started += 1;
    return "captured";
  };

  const late = { busy: false, started: 0 };
  await Promise.all([arrive(false, late), arrive(false, late)]);
  assert.equal(late.started, 2, "claiming after the await lets BOTH requests drive NVDA — the defect");

  const early = { busy: false, started: 0 };
  const results = await Promise.all([arrive(true, early), arrive(true, early)]);
  assert.equal(early.started, 1, "claiming with the check admits exactly one");
  assert.deepEqual(results.sort(), ["429", "captured"], "the second is refused, not queued");
});
