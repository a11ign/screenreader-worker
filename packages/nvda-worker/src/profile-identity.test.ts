/**
 * #561: A WARM PROFILE AND A COLD ONE ARE DIFFERENT EVIDENCE, AND THEY SHARED A CACHE ENTRY.
 *
 * `environmentKey` keys on the screen reader, the driver, the browser, the OS, the protocol and the NVDA
 * settings — each because it changes what NVDA says before this project ever sees it. The Edge profile
 * belongs to that class and was not in it. `browser-profile.mjs`'s own header states the mechanism: a
 * fresh `--user-data-dir` shows Edge's first-run welcome surface, and on a page with no headings NVDA's
 * quick-nav escapes the empty document into that surface and records it as PHANTOM PAGE CONTENT. The
 * U+FFFC incident measured the same variable from the other end — the autofill icon reached 3%, then 8%,
 * then 31% of affected captures as the profile LEARNED, with 26 good/bad pairs disagreeing.
 *
 * ## `gate:stability` cannot cover this, and the reason is the wrong axis rather than a weak gate
 *
 * It compares captures taken minutes apart WITHIN ONE RUN. **A uniformly cold profile is stable by
 * construction** — five cold captures agree with each other exactly. It caught U+FFFC only because the
 * profile was WARMING during the run, a moving variable. Nothing compares evidence ACROSS runs; that is
 * the cache key's job, which is why this had to be a key and not a check.
 *
 * ## MISSING and CHANGED are different states, and the difference is a whole recapture
 *
 * On the day this ships, every guest has a profile and no stamp. If that read as CHANGED, every cached
 * capture would miss at once — the `os`-key recapture paid a second time for a field that has just been
 * introduced and has told us nothing yet. So an unstamped profile Edge has USED is ADOPTED and stamped
 * with the literal `adopted`, which is exactly what `environmentKey` defaults an absent field to.
 *
 * **The two directions are tested separately below**, because a test asserting only that a changed stamp
 * changes the key passes with the adoption inverted — and that inversion is the expensive one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { profileIdentity, readOrStampProfileIdentity, ADOPTED_PROFILE, USED_MARKER, STAMP_FILE }
  from "./browser-profile.mjs";

/** A fake filesystem: a set of paths that exist, plus the contents of any read. */
function fakeDisk(files: Record<string, string>) {
  const written: Array<[string, string]> = [];
  return {
    written,
    deps: {
      exists: (p: string) => p in files,
      read: (p: string) => files[p],
      write: (p: string, body: string) => { written.push([p, body]); files[p] = body; },
      newId: () => "fresh-id",
      log: () => {},
    },
  };
}

const ROOT = "C:\\Users\\witness\\AppData\\Local\\a11y-witness\\edge-profile";
const used = (root: string) => `${root}/${USED_MARKER}`;
const stamp = (root: string) => `${root}/${STAMP_FILE}`;

test("DIRECTION ONE -- an unstamped profile Edge has USED is ADOPTED, stamped once, and the cache key "
  + "does not move. Getting this backwards on day one invalidates every capture on disk", () => {
  const disk = fakeDisk({ [ROOT]: "", [used(ROOT)]: "" });
  const result = readOrStampProfileIdentity(ROOT, disk.deps);

  assert.equal(result.identity, ADOPTED_PROFILE);
  assert.equal(result.adopted, true);
  assert.deepEqual(disk.written, [[stamp(ROOT), ADOPTED_PROFILE]], "stamped exactly once, with `adopted`");
  assert.match(result.why, /adopted an existing profile/,
    "the diagnostic must say WHICH it did -- 'adopted an existing profile' and 'stamped a new one' are "
    + "different facts, and this repo's rule is that they must never be the same silence");

  // The half that matters -- that `adopted` and an absent field produce the SAME key -- is asserted in
  // `capture-cache.test.ts`, beside the key itself. It cannot be asserted here: `packages/lab` depends
  // on `packages/nvda-worker`, so importing `environmentKey` back into the worker is a dependency cycle,
  // the same direction problem `corpus-readers-are-guarded.test.ts` records for its own exemptions.
});

test("a directory Edge has NEVER run in is not a survivor -- it gets a fresh id, because an empty "
  + "profile recreated by something other than this code would otherwise be ADOPTED while stone cold", () => {
  const disk = fakeDisk({ [ROOT]: "" });   // exists, but no `Local State`
  const result = readOrStampProfileIdentity(ROOT, disk.deps);
  assert.equal(result.identity, "fresh-id");
  assert.equal(result.adopted, false);
  assert.match(result.why, new RegExp(`no ${USED_MARKER}`));
});

test("an ABSENT profile gets a fresh id and says so -- the cold-start case the key exists for", () => {
  const result = readOrStampProfileIdentity(ROOT, fakeDisk({}).deps);
  assert.equal(result.identity, "fresh-id");
  assert.match(result.why, /did not exist/);
});

test("a profile already stamped is only READ -- stamping is idempotent, so a polled /health does not "
  + "rewrite the file on every request", () => {
  const disk = fakeDisk({ [ROOT]: "", [used(ROOT)]: "", [stamp(ROOT)]: "abc-123" });
  const result = readOrStampProfileIdentity(ROOT, disk.deps);
  assert.equal(result.identity, "abc-123");
  assert.deepEqual(disk.written, []);
});

test("a stamp that EXISTS and cannot be READ is not an absent one -- adopting there would report a cold "
  + "profile as the corpus's own, so it reports `unreadable` and lets the key move", () => {
  const result = readOrStampProfileIdentity(ROOT, {
    exists: (p: string) => p === ROOT || p === stamp(ROOT) || p === used(ROOT),
    read: () => { throw new Error("EACCES"); },
    write: () => {},
    newId: () => "fresh-id",
    log: () => {},
  });
  assert.equal(result.identity, "unreadable");
  assert.equal(result.adopted, false);
});

test("profileIdentity is PURE and every branch is reachable from its inputs alone -- the decision is "
  + "separable from the disk, which is what makes both directions testable without a guest", () => {
  const id = (over: Partial<Parameters<typeof profileIdentity>[0]>) => profileIdentity({
    stamped: null, profileExists: false, hasBeenUsed: false, freshId: "F", ...over,
  });
  assert.equal(id({ stamped: "S" }).identity, "S");
  assert.equal(id({ profileExists: true, hasBeenUsed: true }).identity, ADOPTED_PROFILE);
  assert.equal(id({ profileExists: true }).identity, "F");
  assert.equal(id({}).identity, "F");
  assert.equal(id({ stamped: ADOPTED_PROFILE }).adopted, true,
    "a profile stamped `adopted` on an earlier boot is still an adopted one");
});
