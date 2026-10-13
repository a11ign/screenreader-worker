/**
 * Guards on the worker's own TEXT, read from its source (#2211).
 *
 * These pin what the worker's comments claim about `displayAdapter`, so a sentence that was corrected once cannot quietly
 * come back. The guards that compare the worker against the field lists in control's `worker-fleet-carried.ts` stay in
 * control, where those lists live: this repository does not import them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerServerSource = () => readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");

/** Sentences that assert the field is unreported. Each is a spelling the old text used or would reword to. */
const CLAIMS_UNREPORTED = [
  /\bno (deployed )?(worker|guest)s? (reports?|sends?) it\b/i,
  /\breads? (as )?`?unknown`? (across|on every|on all)\b/i,
  /\buntil (this code|the worker|it) (is|has been|was) deployed\b/i,
  /\bwhich it will until\b/i,
];
const claimsUnreported = (text: string) => CLAIMS_UNREPORTED.some((claim) => claim.test(text));

/**
 * `displayAdapter`'s own docblock, located by the heading that opens it and the CODE line that ends it, so what is found
 * cannot be a phrase that lives only in prose (#1213's defect).
 */
const workerDisplayAdapterComment = () => {
  const server = workerServerSource();
  const start = server.indexOf("WHICH GRAPHICS ADAPTER THIS GUEST IS RUNNING ON");
  const end = server.indexOf("async function displayAdapter() {");
  assert.ok(start !== -1 && end > start, "server.ts no longer carries displayAdapter's comment to read");
  const between = server.slice(start, end);
  assert.ok(/REPORTED, NEVER GATED/.test(between), "the anchors no longer bracket displayAdapter's comment");
  return between;
};

test("#2211: the worker's own displayAdapter comment claims no absence either", () => {
  const comment = workerDisplayAdapterComment();
  assert.equal(claimsUnreported(comment), false,
    "the reporter still says the fleet reads the field as unknown `until this code is deployed`");
  assert.equal(claimsUnreported("the fleet reading it as `unknown` on every guest -- which it will until this code is deployed"),
    true, "the matcher does not recognise the comment this row removed");
});
