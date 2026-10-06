/**
 * `inFlight` is PER-CAPTURE data, and it was never cleared.
 *
 * `respondWithProgress` (`/progress`) reports `{ busy, capturing: null }` only when `inFlight` is falsy.
 * `runCapture` sets `inFlight = { url, startedAt, marks }` at the start of every capture and — until this
 * fix — never reset it, in EITHER its success or its failure path. So after the very first capture a
 * worker ever ran, `inFlight` stayed truthy for the rest of the process's life: an idle worker with
 * `busy: false` kept reporting the LAST capture's URL as `capturing` and an `elapsedMs` that grew forever.
 *
 * Measured in production, recorded in `fleet-status.mjs`'s own comment on the workaround it had to add:
 * `{busy: false, capturing: ".../table-unassociated-hilltown/bad.html", elapsedMs: 2526239}` — 42 minutes
 * after that capture had finished, and still climbing. That consumer already defends itself by checking
 * `progress.busy` before trusting `capturing`/`elapsedMs`, but a defensive READER is not a fix for a
 * SOURCE that still hands out stale state to whoever asks — a future consumer, or a human reading
 * `/progress` directly on a loaded guest to answer "is this box actually stuck?", would be misled exactly
 * the way `fleet-status.mjs`'s comment describes.
 *
 * `server.mjs` needs guidepup and therefore a screen reader, so — same reasoning `busy-claim.test.ts`
 * already gives for the identical constraint — this asserts the property against the SOURCE rather than
 * by running a capture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const server = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");

/** `runCapture`'s own body — `busy`'s claim/release partner, and where `inFlight` is set. */
function runCaptureBody(): string {
  const body = /async function runCapture\([\s\S]*?\n}\n/.exec(server)?.[0];
  assert.ok(body, "runCapture not found; this scan is broken, not passing");
  return body as string;
}

test("inFlight is set at the start of a capture", () => {
  assert.match(runCaptureBody(), /inFlight\s*=\s*\{\s*url,\s*startedAt,\s*marks\s*\}/,
    "runCapture no longer records the in-flight capture — /progress would have nothing to report while one runs");
});

test("inFlight is cleared in the SAME finally block that releases busy", () => {
  const body = runCaptureBody();
  const finallyBlock = /finally\s*\{([\s\S]*?)\}\s*$/.exec(body)?.[1];
  assert.ok(finallyBlock, "runCapture has no finally block; busy/inFlight cannot be released on every path");
  assert.match(finallyBlock as string, /busy\s*=\s*false/,
    "the finally block no longer releases busy — this scan has drifted from busy-claim.test.ts's own assertion");
  assert.match(finallyBlock as string, /inFlight\s*=\s*null/,
    "inFlight is not reset to null in the SAME finally as busy, so it outlives every capture — see this "
    + "file's header for the measured production symptom (a worker reporting a growing elapsedMs forever)");
});

test("respondWithProgress's own contract already exists for the cleared state", () => {
  // The fix does not invent new behaviour: `respondWithProgress` has always had a branch for "nothing is
  // in flight" — it was simply unreachable once the first capture had ever run. Pinning that the branch
  // still exists is what makes the two tests above meaningful: clearing `inFlight` routes every idle
  // /progress call through a path this file already knew was correct.
  assert.match(server, /if\s*\(!inFlight\)\s*return\s*send\(res,\s*200,\s*\{\s*busy,\s*capturing:\s*null\s*\}\)/,
    "respondWithProgress no longer has an explicit not-in-flight branch — the contract this fix relies on has changed");
});
