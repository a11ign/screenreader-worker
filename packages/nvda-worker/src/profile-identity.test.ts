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
import { profileIdentity, readOrStampProfileIdentity, ADOPTED_PROFILE, USED_MARKER, STAMP_FILE,
  ORIGIN_FILE, ORIGIN_ADOPTED, ORIGIN_FRESH, originDisagreement }
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

/**
 * #1201: ADOPTION IS A RECORDED FACT FIRST, AND THESE FIXTURES PLANT LITERAL STRINGS ON PURPOSE.
 *
 * The row asked for a mutation -- make `USED_MARKER` match nothing -- and said the suite must go red.
 * **It could not.** Measured before building: the mutation left the suite at 6/0, because the fixtures
 * above derive their key from the constant under test:
 *
 * ```ts
 * const used = (root: string) => `${root}/${USED_MARKER}`;
 * ```
 *
 * Under mutation the fixture plants `ROOT/NoSuchFileEdgeNeverWrites` and the code looks for
 * `ROOT/NoSuchFileEdgeNeverWrites`. **They agree by construction**, so a test built that way can never
 * catch its own constant being wrong. Driven with a literal fixture instead, the same mutation is plain:
 * `identity=adopted` becomes `identity=fresh-id` for a profile Edge has genuinely used.
 *
 * So every fixture below writes the string Edge actually writes, and the words provisioning actually
 * records, rather than interpolating the exports. **The literal is also the least fragile spelling to
 * leave in a test** -- quotation marks say a string is being exhibited, so a rename tool leaves it alone,
 * which is exactly the property wanted from a guard against a rename.
 */
const LITERAL_MARKER = "Local State";
const LITERAL_ORIGIN = ".a11y-profile-origin";
const LITERAL_ADOPTED = "adopted-existing";
const LITERAL_FRESH = "created-fresh";

test("#1201 clause 1 (MUTATION TARGET: the marker rename): the exported names still equal the literals these fixtures plant", () => {
  // Without this, a rename makes every test below silently test a file nothing reads -- the fixture
  // problem one level up. This is the ONE place the two spellings are compared, deliberately.
  assert.equal(USED_MARKER, LITERAL_MARKER);
  assert.equal(ORIGIN_FILE, LITERAL_ORIGIN);
  assert.equal(ORIGIN_ADOPTED, LITERAL_ADOPTED);
  assert.equal(ORIGIN_FRESH, LITERAL_FRESH);
});

test("#1201 clause 2 (MUTATION TARGET: the logic): with a record, adoption survives a missing marker", () => {
  // THE WHOLE ROW. Today, a marker that matches nothing flips every unstamped profile to "fresh" and
  // nothing reports it. With provisioning's record present, the marker is corroboration and its absence
  // cannot move the identity.
  //
  // WHICH MUTATION THIS CATCHES, because the label was wrong once and it is worth saying which is which.
  // This takes `hasBeenUsed` as a parameter, so renaming `USED_MARKER` cannot reach it -- that spelling
  // of the row's mutation is caught by clause 1's literal comparison. This one catches the LOGIC
  // regressing: the record ceasing to decide, so a missing marker moves the identity again. Both
  // spellings of "the marker stops matching" are covered, by different clauses, and a reader chasing a
  // failure should not have to discover that here.
  const recordedAdopted = profileIdentity({
    stamped: null, profileExists: true, hasBeenUsed: false, freshId: "F", recorded: LITERAL_ADOPTED,
  });
  assert.equal(recordedAdopted.identity, ADOPTED_PROFILE,
    "a profile provisioning recorded as adopted must stay adopted when the marker cannot be found -- "
    + "otherwise the corpus's own profile silently gets a new cache key and every capture on disk is "
    + "orphaned, which is the harm this row exists to prevent");
  assert.equal(recordedAdopted.adopted, true);

  // And the reverse, so this is not satisfied by "the record always says adopted".
  const recordedFresh = profileIdentity({
    stamped: null, profileExists: true, hasBeenUsed: true, freshId: "F", recorded: LITERAL_FRESH,
  });
  assert.equal(recordedFresh.identity, "F",
    "a profile provisioning recorded as fresh must not be adopted just because the marker is present");
});

test("#1201 clause 3: the two sources DISAGREEING is reported, not resolved in silence", () => {
  // Precedence does not mean the loser goes unmentioned. A recorded adoption whose profile has never
  // been used, or a used profile provisioning called fresh, is one of the two having been wrong.
  const adoptedButCold = originDisagreement({ recorded: LITERAL_ADOPTED, hasBeenUsed: false });
  assert.match(String(adoptedButCold), /Local State/,
    "the disagreement must name the marker, or a reader cannot tell which two things disagreed");
  assert.match(String(adoptedButCold), /wiped after provisioning|no longer writes/,
    "and must name BOTH causes -- 'the profile was wiped' and 'Edge stopped writing it' need different "
    + "responses, and this cannot tell them apart, so it must not pick one");

  const freshButUsed = originDisagreement({ recorded: LITERAL_FRESH, hasBeenUsed: true });
  assert.match(String(freshButUsed), /warmer than the record claims/);

  // SILENT WHEN THEY AGREE, and when there is nothing to disagree with. A line printed on every ordinary
  // capture stops being read, which is how the diagnostic that matters gets missed.
  assert.equal(originDisagreement({ recorded: LITERAL_ADOPTED, hasBeenUsed: true }), null);
  assert.equal(originDisagreement({ recorded: LITERAL_FRESH, hasBeenUsed: false }), null);
  assert.equal(originDisagreement({ recorded: null, hasBeenUsed: false }), null,
    "no record means nothing to contradict -- the pre-#1201 state is not a disagreement");
});

test("#1201 clause 4: end to end on a fake disk, with the LITERAL file names", () => {
  // The disk read is the only line USED_MARKER affects, and the fixtures above cannot see it. This one
  // plants both files by their literal names and drives `readOrStampProfileIdentity` itself.
  const ROOT2 = "C:\\p";
  const planted = new Set([ROOT2, `${ROOT2}/${LITERAL_ORIGIN}`]);
  const lines: string[] = [];
  const result = readOrStampProfileIdentity(ROOT2, {
    exists: (p: string) => planted.has(p),
    read: () => LITERAL_ADOPTED,
    write: () => {},
    newId: () => "fresh-id",
    log: (l: string) => lines.push(l),
  });
  // POSITIVE CONTROL: print what was resolved before asserting on it. A module that failed to load and a
  // wrong identity produce the same failure text otherwise.
  assert.equal(result.identity, ADOPTED_PROFILE,
    `resolved ${JSON.stringify(result.identity)} from a planted origin record with no marker present`);
  assert.ok(lines.some((l) => l.includes("SOURCES DISAGREE")),
    `the marker is absent while the record says adopted -- that must be logged. Lines: ${JSON.stringify(lines)}`);
});
