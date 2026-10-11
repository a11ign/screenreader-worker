// THE WORKER'S AUTHENTICATOR CODE (a11ign#4978). The vectors are RFC 6238 Appendix B as LITERALS, the same ones the CLI's `totp.test.ts`
// pins (a11y-witness #4977): two interpreters, one set of numbers, and neither imports the other.
//
// POSITIVE CONTROL: the Appendix B vectors, and `codeForUse` returning the current window's code when there is time.
// NEGATIVE CONTROL: the window edge returns the NEXT window's code after the sleep; a missing, empty, non-base32 or short seed is refused by
// the variable's NAME, and no message carries the seed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { codeForUse, requireTotpSeed, totpCode } from "./totp.ts";

// The RFC's ASCII seeds ("1234567890" repeated to 20, 32 and 64 bytes), in the base32 an authenticator app shows.
const SEED_SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SEED_SHA256 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
const SEED_SHA512 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

const VECTORS: Array<[number, string, string, string]> = [
  // [T seconds, SHA-1, SHA-256, SHA-512], eight digits as the RFC prints them
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("POSITIVE CONTROL: RFC 6238 Appendix B vectors, SHA-1, SHA-256 and SHA-512, eight digits", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    assert.equal(totpCode(SEED_SHA1, t * 1000, { digits: 8 }), sha1, `SHA1 at T=${t}`);
    assert.equal(totpCode(SEED_SHA256, t * 1000, { digits: 8, algorithm: "SHA256" }), sha256, `SHA256 at T=${t}`);
    assert.equal(totpCode(SEED_SHA512, t * 1000, { digits: 8, algorithm: "SHA512" }), sha512, `SHA512 at T=${t}`);
  }
});

test("the defaults are six digits, thirty seconds, SHA-1, and a code is zero-padded", () => {
  assert.equal(totpCode(SEED_SHA1, 59_000), "287082");
  assert.equal(totpCode(SEED_SHA1, 1111111109_000), "081804");
  assert.equal(totpCode(SEED_SHA1, 59_000, { periodSeconds: 60 }), totpCode(SEED_SHA1, 0, { periodSeconds: 60 }));
  assert.notEqual(totpCode(SEED_SHA1, 59_000, { periodSeconds: 30 }), totpCode(SEED_SHA1, 0, { periodSeconds: 30 }));
});

test("a seed is read as an authenticator app prints it: lower case, grouped, padded", () => {
  const grouped = "gezd gnbv-gy3t qojq GEZDGNBVGY3TQOJQ====";
  assert.equal(totpCode(grouped, 59_000, { digits: 8 }), "94287082");
});

test("POSITIVE CONTROL: with time left, codeForUse returns this window's code and does not sleep", async () => {
  const slept: number[] = [];
  const code = await codeForUse(SEED_SHA1, () => 1111111100_000, async (ms) => { slept.push(ms); });
  assert.equal(code, totpCode(SEED_SHA1, 1111111100_000));
  assert.deepEqual(slept, []);
});

test("NEGATIVE CONTROL: under three seconds left, codeForUse sleeps to the edge and returns the NEXT window's code", async () => {
  const windowEnd = 1111111110_000; // a multiple of 30 s
  const slept: number[] = [];
  let now = windowEnd - 2_000;
  const code = await codeForUse(SEED_SHA1, () => now, async (ms) => { slept.push(ms); now += ms; });
  assert.deepEqual(slept, [2_000]);
  assert.equal(code, totpCode(SEED_SHA1, windowEnd));
  assert.notEqual(code, totpCode(SEED_SHA1, windowEnd - 2_000));
});

test("NEGATIVE CONTROL: the edge is exactly three seconds: three left waits for nothing, under three waits", async () => {
  const windowEnd = 1111111110_000;
  let slept = 0;
  const sleep = async () => { slept += 1; };
  await codeForUse(SEED_SHA1, () => windowEnd - 3_000, sleep);
  assert.equal(slept, 0);
  await codeForUse(SEED_SHA1, () => windowEnd - 2_999, sleep);
  assert.equal(slept, 1);
});

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DP"; // 15 bytes; a canary for the leak check
const refusals = (): Array<[string, () => unknown]> => [
  ["unset", () => requireTotpSeed({}, "MFA_SEED")],
  ["empty", () => requireTotpSeed({ MFA_SEED: "" }, "MFA_SEED")],
  ["blank", () => requireTotpSeed({ MFA_SEED: "   " }, "MFA_SEED")],
  ["non-base32", () => requireTotpSeed({ MFA_SEED: `${SECRET}!1` }, "MFA_SEED")],
  ["under 10 bytes", () => requireTotpSeed({ MFA_SEED: "JBSWY3DPEE" }, "MFA_SEED")],
];

test("NEGATIVE CONTROL: an unset, empty, non-base32 or short seed is refused by the variable's NAME", () => {
  for (const [what, run] of refusals()) {
    assert.throws(run, (e: Error) => e.name === "TotpSeedError" && e.message.includes("MFA_SEED"), what);
  }
});

test("NEGATIVE CONTROL: no refusal message carries the seed value, and a valid seed passes through", () => {
  const candidates = [`${SECRET}!1`, "JBSWY3DPEE", "JBSWY3DPEE=", "not base32 at all 01"];
  for (const value of candidates) {
    try {
      requireTotpSeed({ MFA_SEED: value }, "MFA_SEED");
      assert.fail(`${value} should have been refused`);
    } catch (e) {
      assert.ok(e instanceof Error && !e.message.includes(value) && !e.message.includes(value.trim()), `message carries the seed: ${(e as Error).message}`);
    }
  }
  assert.equal(requireTotpSeed({ MFA_SEED: SECRET }, "MFA_SEED"), SECRET);
  // totpCode refuses a bad seed too, and says nothing of its value
  assert.throws(() => totpCode(`${SECRET}!1`, 0), (e: Error) => !e.message.includes(SECRET));
});

test("options out of range are refused", () => {
  assert.throws(() => totpCode(SEED_SHA1, 0, { digits: 5 }), RangeError);
  assert.throws(() => totpCode(SEED_SHA1, 0, { digits: 9 }), RangeError);
  assert.throws(() => totpCode(SEED_SHA1, 0, { periodSeconds: 0 }), RangeError);
  assert.throws(() => totpCode(SEED_SHA1, 0, { algorithm: "MD5" as never }), RangeError);
});
