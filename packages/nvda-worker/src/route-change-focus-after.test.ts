/**
 * #1497: the focus read after the route probe's Tab is retried once, never re-Tabbed, and a read that fails
 * every time is NAMED rather than recorded as a bare null.
 *
 * Imports only `capture-pure.mjs`: `capture-probes.mjs` imports `@guidepup/guidepup`, which throws at import
 * where no screen reader exists (measured on the agents host: "No available supported screen readers"), so the
 * decision lives in the pure module and the probe keeps only the call. The Tab and the read are injected and
 * counted, so every assertion is about what the helper DID, not what it returned alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFocusAfterTab, FOCUS_READ_ATTEMPTS } from "./capture-pure.mjs";

/** A Tab and a read, scripted: each read answer is a string to return or an Error to throw, in order. */
function scripted(reads: Array<string | null | undefined | Error>, { tabFails = false } = {}) {
  const calls = { tabs: 0, reads: 0 };
  return {
    calls,
    io: {
      pressTab: async () => {
        calls.tabs += 1;
        if (tabFails) throw new Error("Tab timed out");
      },
      readFocused: async () => {
        const answer = reads[calls.reads];
        calls.reads += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

// The reading all six measured variants recorded, and the one the base capture lost (#1497, 5657549839).
const LANDED = "News and updates, link, focused, linked";

test("#1497 ACCEPTANCE: a focus read that fails ONCE is retried, and the retry's reading is recorded", async () => {
  const { calls, io } = scripted([new Error("reportFocusedControl threw"), LANDED]);
  const result = await readFocusAfterTab(io);
  assert.deepEqual(result, { nextFocusAfter: LANDED, unmeasured: null },
    "the capture that read BLIND lost exactly this reading to one failed read");
  assert.equal(calls.reads, 2, "read, failed, read again");
  assert.equal(calls.tabs, 1, "and Tab was pressed ONCE: a second Tab would record the control one stop further on");
});

test("#1497: a read that fails EVERY time records null WITH a reason naming each failure", async () => {
  const { calls, io } = scripted([new Error("first failure"), new Error("second failure")]);
  const result = await readFocusAfterTab(io);
  assert.equal(result.nextFocusAfter, null, "no reading is still no reading -- nothing is invented");
  assert.equal(typeof result.unmeasured, "string", "but the record says why, instead of a bare null");
  assert.match(String(result.unmeasured), /read 1: first failure \| read 2: second failure/);
  assert.equal(calls.reads, FOCUS_READ_ATTEMPTS, "every attempt was made");
  assert.equal(calls.tabs, 1);
});

test("#1497 CONTROL: a read that answers first time is not retried, and an EMPTY answer is a reading", async () => {
  const first = scripted([LANDED, "never read"]);
  assert.deepEqual(await readFocusAfterTab(first.io), { nextFocusAfter: LANDED, unmeasured: null });
  assert.equal(first.calls.reads, 1, "no retry when the read answered");
  for (const silent of ["", null, undefined]) {
    const run = scripted([silent]);
    assert.deepEqual(await readFocusAfterTab(run.io), { nextFocusAfter: "", unmeasured: null },
      `${JSON.stringify(silent)}: focus that went somewhere silent is an observation, recorded as "", as before`);
    assert.equal(run.calls.reads, 1);
  }
});

test("#1497: a Tab that throws does not stop the read, and is named if the reads fail too", async () => {
  const recovered = scripted([LANDED], { tabFails: true });
  assert.deepEqual(await readFocusAfterTab(recovered.io), { nextFocusAfter: LANDED, unmeasured: null },
    "the probe has always read after a failed Tab; a reading taken then is still a reading");
  const lost = scripted([new Error("x"), new Error("y")], { tabFails: true });
  assert.match(String((await readFocusAfterTab(lost.io)).unmeasured), /^no focus reading after Tab .*Tab: Tab timed out/);
});

test("#1497 WIRING: the route probe's focus read goes through readFocusAfterTab, and an unmeasured reason reaches its mark", () => {
  // READ AS TEXT, never imported: `capture-probes.mjs` imports @guidepup/guidepup, which throws here. Anchored on
  // code shapes (`return readFocusAfterTab({`, a spread into the mark), not on words a comment could carry.
  const source = readFileSync(new URL("./capture-probes.mjs", import.meta.url), "utf8");
  assert.match(source, /\breadFocusAfterTab,\n\} from "\.\/capture-pure\.mjs";/, "the helper is imported from the pure module");
  const start = source.indexOf("async function focusedAfterTab(");
  assert.ok(start >= 0, "focusedAfterTab is gone from capture-probes.mjs");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /return readFocusAfterTab\(\{/, "the probe's read is the pure helper's, retried once");
  assert.doesNotMatch(body, /\bcatch\b/, "and no local catch turns a failed read back into a bare null");
  assert.match(source, /const nextFocusAfter = focusAfter\.nextFocusAfter;/, "the typed field is the helper's reading");
  assert.match(source, /\.\.\.\(focusAfter\.unmeasured \? \{ nextFocusAfterUnmeasured: focusAfter\.unmeasured \} : \{\}\)/,
    "and a reason for no reading is recorded on the routeChange mark instead of vanishing");
});
