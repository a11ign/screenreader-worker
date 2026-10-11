// THE WORKER'S otpauth:// READER (a11ign#4997). The literals are the CLI sibling's (a11y-witness #4992), repeated and not imported: two
// interpreters, one set of cases.
//
// POSITIVE CONTROL: a URI's algorithm, digits and period come back exactly; a bare seed defaults to SHA-1/6/30; the period reaches the code.
// NEGATIVE CONTROL: hotp, a missing secret, MD5, digits=5, period=0, and a non-base32 value are each refused by NAME, with the value absent.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTotpSecret } from "./otpauth.ts";
import { totpCode, TotpSeedError } from "./totp.ts";

// "12345678901234567890" in base32, the RFC 6238 SHA-1 seed.
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SECOND = 1000;
const uri = (query: string, scheme = "totp"): string => `otpauth://${scheme}/Example:me@example.com?${query}`;

test("POSITIVE CONTROL: a URI's algorithm, digits and period are returned exactly", () => {
  const parsed = parseTotpSecret(uri(`secret=${RFC_SEED}&algorithm=SHA256&digits=8&period=60&issuer=Example`));
  assert.deepEqual(parsed, { seed: RFC_SEED, algorithm: "SHA256", digits: 8, periodSeconds: 60 });
});

test("POSITIVE CONTROL: a bare seed, and a URI with only a secret, return SHA-1, 6 digits and 30 s", () => {
  const defaults = { seed: RFC_SEED, algorithm: "SHA1", digits: 6, periodSeconds: 30 };
  assert.deepEqual(parseTotpSecret(RFC_SEED), defaults);
  assert.deepEqual(parseTotpSecret(uri(`secret=${RFC_SEED}`)), defaults);
});

test("POSITIVE CONTROL: the RFC 6238 SHA-1 seed as a URI computes the Appendix B code through totpCode", () => {
  const { seed, ...options } = parseTotpSecret(uri(`secret=${RFC_SEED}&digits=8`));
  assert.equal(totpCode(seed, 59 * SECOND, options), "94287082");
});

test("POSITIVE CONTROL: the period reaches the code, so a 60 s URI is not read as 30 s", () => {
  const { seed, ...options } = parseTotpSecret(uri(`secret=${RFC_SEED}&period=60`));
  assert.equal(totpCode(seed, 59 * SECOND, options), totpCode(seed, 0, { periodSeconds: 60 }));
  assert.notEqual(totpCode(seed, 59 * SECOND, options), totpCode(seed, 59 * SECOND));
});

const REFUSALS: readonly (readonly [string, string, string])[] = [
  ["hotp", uri(`secret=${RFC_SEED}&counter=0`, "hotp"), "counter-based"],
  ["missing secret", uri("algorithm=SHA1"), "no secret parameter"],
  ["algorithm=MD5", uri(`secret=${RFC_SEED}&algorithm=MD5`), "algorithm must be one of"],
  ["digits=5", uri(`secret=${RFC_SEED}&digits=5`), "digits must be a whole number"],
  ["period=0", uri(`secret=${RFC_SEED}&period=0`), "period must be a whole number"],
  ["period=301", uri(`secret=${RFC_SEED}&period=301`), "period must be a whole number"],
  ["period=abc", uri(`secret=${RFC_SEED}&period=abc`), "period must be a whole number"],
  ["non-base32 secret in a URI", uri("secret=NOT1BASE32SECRET8%2F"), "secret parameter is not base32"],
  ["non-base32 bare value", "NOT1BASE32SECRET8/", "is not base32"],
  ["short seed", "JBSWY3DP", "under 10 bytes"],
  ["a URI of no totp form", "otpauth://" + RFC_SEED, "not of the form otpauth://totp/"],
];

for (const [label, value, reason] of REFUSALS) {
  test(`NEGATIVE CONTROL: ${label} is refused by name, and the message does not carry the value`, () => {
    assert.throws(
      () => parseTotpSecret(value),
      (error: unknown) => {
        assert.ok(error instanceof TotpSeedError, "a TotpSeedError");
        assert.ok(error.message.includes(reason), `names its reason: ${error.message}`);
        return true;
      },
    );
  });
}

test("NEGATIVE CONTROL: no refusal message holds the secret, the URI or any piece of either", () => {
  const secrets = [RFC_SEED, "NOT1BASE32SECRET8", "example.com"];
  for (const [, value] of REFUSALS) {
    try {
      parseTotpSecret(value);
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof TotpSeedError);
      for (const secret of [...secrets, value]) assert.ok(!error.message.includes(secret), `leaked ${secret}`);
    }
  }
});
