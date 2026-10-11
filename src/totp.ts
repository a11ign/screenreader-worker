// AN AUTHENTICATOR-APP (TOTP, RFC 6238) CODE, COMPUTED BY THE WORKER (a11ign#4978, part of #4084 outcome 1).
//
// This is the worker's own copy of the CLI's `totp.ts` (a11y-witness #4977): there are two interpreters because there cannot be one, so each
// holds the pure part and pins the same RFC 6238 Appendix B vectors as literals (`totp.test.ts`). Nothing imports this yet: the `fill` step
// that would use it is the wiring row's, held for the chairman's design direction.
//
// THE SEED IS A SECRET, AND NO MESSAGE HERE CARRIES ITS VALUE. A refusal names the VARIABLE, which is not a secret, and what is wrong with
// the value in words that hold for any value.
import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";
export type TotpOptions = { digits?: number; periodSeconds?: number; algorithm?: TotpAlgorithm };

/** A code read in the last moments of its window is stale by the time the page checks it, so the next window's code is used instead. */
export const MIN_SECONDS_LEFT = 3;
/** RFC 4226 asks 128 bits at least; a seed under this is a typo or a truncated paste, not a key. */
export const MIN_SEED_BYTES = 10;

const DEFAULTS = { digits: 6, periodSeconds: 30, algorithm: "SHA1" } as const;
const HMAC_NAME: Record<TotpAlgorithm, string> = { SHA1: "sha1", SHA256: "sha256", SHA512: "sha512" };
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MS = 1000;
const MIN_DIGITS = 6;
const MAX_DIGITS = 8;

export class TotpSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpSeedError";
  }
}

/** Decodes RFC 4648 base32, as authenticator apps print it: case-insensitive, with spaces, hyphens and `=` padding ignored. Null if not base32. */
export function decodeBase32(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

function resolveOptions(options: TotpOptions) {
  const { digits, periodSeconds, algorithm } = { ...DEFAULTS, ...options };
  if (!Number.isInteger(digits) || digits < MIN_DIGITS || digits > MAX_DIGITS) throw new RangeError(`totp digits must be an integer from ${MIN_DIGITS} to ${MAX_DIGITS}`);
  if (!Number.isInteger(periodSeconds) || periodSeconds <= 0) throw new RangeError("totp period must be a positive whole number of seconds");
  if (!(algorithm in HMAC_NAME)) throw new RangeError("totp algorithm must be SHA1, SHA256 or SHA512");
  return { digits, periodSeconds, algorithm };
}

function keyFrom(seed: string): Buffer {
  const key = decodeBase32(seed);
  if (key === null) throw new TotpSeedError("the authenticator seed is not base32");
  if (key.length < MIN_SEED_BYTES) throw new TotpSeedError(`the authenticator seed decodes to under ${MIN_SEED_BYTES} bytes`);
  return key;
}

/** The code for the window containing `nowMs` (RFC 6238 over RFC 4226 dynamic truncation). `seed` is the base32 text an authenticator app shows. */
export function totpCode(seed: string, nowMs: number, options: TotpOptions = {}): string {
  const { digits, periodSeconds, algorithm } = resolveOptions(options);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / MS / periodSeconds)));
  const mac = createHmac(HMAC_NAME[algorithm], keyFrom(seed)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 10 ** digits).padStart(digits, "0");
}

/**
 * A code to type NOW. With under `MIN_SECONDS_LEFT` left in the window it waits for the next one and returns THAT window's code: the clock and
 * the sleep are injected so a test pins the edge instead of racing it. The next window's start is the floor of the second read, so a `sleep`
 * that returns early (or a pinned clock) still yields the next window's code and never the expiring one.
 */
export async function codeForUse(
  seed: string,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
  options: TotpOptions = {},
): Promise<string> {
  const { periodSeconds } = resolveOptions(options);
  const periodMs = periodSeconds * MS;
  const now = clock();
  const windowEnd = (Math.floor(now / periodMs) + 1) * periodMs;
  if (windowEnd - now >= MIN_SECONDS_LEFT * MS) return totpCode(seed, now, options);
  await sleep(windowEnd - now);
  return totpCode(seed, Math.max(clock(), windowEnd), options);
}

/** The seed from `env[name]`, validated. A refusal names the variable and never a value; the seed itself is never logged by the caller either. */
export function requireTotpSeed(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new TotpSeedError(`the authenticator seed variable ${name} is not set or is empty`);
  const key = decodeBase32(value);
  if (key === null) throw new TotpSeedError(`the authenticator seed in ${name} is not base32`);
  if (key.length < MIN_SEED_BYTES) throw new TotpSeedError(`the authenticator seed in ${name} decodes to under ${MIN_SEED_BYTES} bytes`);
  return value;
}
