// @ts-check
/**
 * Keep the durable Edge profile durable *and* bounded, and clear strays left by a previous worker.
 *
 * The profile is deliberately persistent: a fresh `--user-data-dir` shows Edge's first-run
 * welcome/sign-in surface, and on a page with no headings NVDA's quick-nav escapes the empty document
 * into that surface and records it as phantom page content. So it must survive. **Durable is not the
 * same as unbounded**, and nothing was enforcing the difference.
 *
 * Measured across three otherwise identical guests, freshly booted:
 *
 *   a11y-worker    511 MB profile, 5 orphaned msedge processes   ~21 s per capture
 *   a11y-worker-2  261 MB profile, 0 orphaned                    ~11 s per capture
 *   a11y-worker-3  170 MB profile, 0 orphaned                    ~11 s per capture
 *
 * Both halves of that are known failure modes rather than novel ones. A Chromium profile with
 * accumulated cache stalls the browser's main thread during startup — the standard diagnostic is "does
 * a fresh profile launch fast?", and the standard fix is to rebuild the profile. And orphaned Edge
 * processes are already recorded in this repo as an outage: eight of them on a 4 GB guest is the load
 * that made the next `nvda.start` time out, with failures compounding until the worker could not capture
 * at all.
 *
 * Since Edge launch (`windowsActivate`) is the single largest phase of a capture, a slow-starting
 * browser is not a cosmetic problem.
 *
 * **Both jobs run at BOOT and nowhere else.** A capture owns Edge for its whole duration, so pruning or
 * killing at any other moment would race it. At boot no capture can be in flight, which makes "kill
 * every msedge" safe here and nowhere else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { errorText } from "./error-text.mjs";

/**
 * Regenerable subtrees. Every one of these is a cache or a session record that Chromium rebuilds on
 * demand; none of them is what suppresses the first-run experience (that is `Local State`, `Preferences`
 * and the profile's existence, all of which are left alone).
 *
 * The `Sessions`/`Current *`/`Last *` entries are here for a second reason: they are what makes Edge
 * try to restore a previous window on launch, which both slows startup and risks restoring page content
 * into a capture.
 */
/**
 * Always dropped, whatever the profile size, because they have no function for a capture worker and at
 * least one of them grows without bound.
 *
 * `BrowserMetrics` is the ONLY entry, and the list is deliberately this short. Edge writes a histogram
 * file there **per launch**, this worker launches Edge once per capture, and on the busiest guest it had
 * reached **348 MB of a 448 MB profile**. It is write-only telemetry nothing here reads, it grows without
 * bound, and it is on disk — which is why the guest carrying it stayed slow across reboots.
 *
 * **Everything else was removed from this list after it did harm.** It also held Edge's component
 * payloads (entity extraction, wallet, shopping, subresource filter, DRM) on the reasoning that a
 * screen-reader appliance does not need them. That reasoning was wrong in a way I could not undo: the
 * guests have Edge's auto-updater disabled, so once deleted those components **never came back**, and the
 * two guests I pruned went from 11-12 s captures to ~26 s and stayed there across sixteen captures. I
 * could not prove the components caused it and could not restore them to find out.
 *
 * The lesson is the list, not the comment: prune only what is proven to grow without bound and proven to
 * be unread. "Probably unnecessary" is not a reason to delete something you cannot put back.
 */
const ALWAYS_REGENERABLE = [
  "BrowserMetrics",
];

/**
 * Chromium's stored form data, dropped at every boot.
 *
 * This is where autofill keeps what it has learned. `probeForms` submits forms, so the profile is
 * TAUGHT by the very act of capturing, and a taught profile then draws a suggestion affordance inside
 * recognised inputs -- which NVDA announces as an embedded object appended to the field:
 *
 *     "Recipient name, edit, \ufffc"     instead of     "Recipient name, edit"
 *
 * So the same unchanged page announces differently depending on how many form pages were captured
 * before it. Measured rising from 3% to 31% of affected captures over the corpus's life, with 26
 * good/bad pairs disagreeing -- a comparison polluted by evidence that has nothing to do with
 * accessibility.
 *
 * **Command-line flags alone were not enough, and finding that out cost a re-run.**
 * `--disable-features=AutofillServerCommunication,AutofillAddressProfileSavePrompt` stops Edge SAVING
 * new entries and querying the server, but it happily offers entries the profile already holds. One
 * guest measured 0 of 12 and another still varied, purely because their profiles had learned different
 * amounts. Deleting the store is what makes it deterministic.
 *
 * Not size-gated: correctness, not housekeeping. `Web Data` is small, Chromium recreates it on demand,
 * and nothing a capture needs lives in it.
 */
const FORM_DATA_STORES = [
  "Default/Web Data",
  "Default/Web Data-journal",
  "Default/Login Data",
  "Default/Login Data-journal",
];

const REGENERABLE = [
  "Default/Cache", "Default/Code Cache", "Default/GPUCache", "Default/DawnCache",
  "Default/DawnGraphiteCache", "Default/DawnWebGPUCache", "Default/GrShaderCache",
  "Default/Service Worker/CacheStorage", "Default/Service Worker/ScriptCache",
  "Default/Sessions", "Default/Current Session", "Default/Current Tabs",
  "Default/Last Session", "Default/Last Tabs",
  "GrShaderCache", "ShaderCache", "component_crx_cache", "GraphiteDawnCache",
];

/**
 * A last-resort valve, not routine maintenance — and set high because pruning caches did measurable
 * HARM at 200 MB.
 *
 * The evidence: a guest with a 261 MB profile was running 11-12 s captures perfectly happily. Dropping
 * its caches at a 200 MB threshold pushed it to 63 s and it was still only back to ~28 s eight captures
 * later, because Chromium had to rebuild everything. The cache was doing its job.
 *
 * The bulk problem was never the cache — it was 348 MB of `BrowserMetrics`, which is in the always-list
 * above. With that gone, Chromium caps its own cache, so this threshold should never be reached; it
 * exists only so a genuinely runaway profile is not left alone forever.
 */
const PRUNE_ABOVE_MB = 800;

/**
 * Which regenerable paths exist and should go, given a profile size.
 *
 * Pure so the policy can be tested without a filesystem: the risky part of this feature is *what* it
 * deletes, and that decision deserves a test rather than a comment.
 *
 * @param {{ megabytes: number | null, root: string, exists: (path: string) => boolean }} profile
 * @returns {string[]} absolute paths to remove; empty when the profile is small enough to leave alone
 */
export function prunablePaths({ megabytes, root, exists }) {
  const absolute = (/** @type {string} */ relative) => join(root, ...relative.split("/"));
  const always = [...ALWAYS_REGENERABLE, ...FORM_DATA_STORES].map(absolute).filter(exists);
  // The cache list is size-gated because a warm cache genuinely speeds Edge up; the always-list is not,
  // because none of it helps and BrowserMetrics actively hurts.
  if (megabytes === null || megabytes <= PRUNE_ABOVE_MB) return always;
  return [...always, ...REGENERABLE.map(absolute).filter(exists)];
}

/**
 * Drop the regenerable parts of an oversized profile. Returns what it removed.
 *
 * @param {string} root
 * @param {number | null} megabytes current size, from diagnostics.treeSize
 * @param {(line: string) => void} log
 */
export async function pruneEdgeProfile(root, megabytes, log) {
  const targets = prunablePaths({ megabytes, root, exists: existsSync });
  if (!targets.length) return [];
  log(`Edge profile is ${megabytes} MB; dropping ${targets.length} regenerable path(s)`);
  const removed = [];
  for (const path of targets) {
    try {
      // AWAITED, not `rmSync`. Deleting an Edge profile's caches recursively is tens of thousands of file
      // operations, and doing it synchronously blocked Node's event loop at boot — so the port was bound and
      // nothing answered, which reads as a dead worker. Measured on a guest whose profile had grown to 336 MB
      // through real-page captures: `worker-ctl up` reported NOT ready after 180 s, repeatedly, and the profile
      // grows with every capture so it got worse each time.
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      // Locked by something, or already gone. Pruning is best-effort by design: a profile we could not
      // shrink is slow, but a worker that refuses to start because of it is worse.
      log(`  could not remove ${path}: ${errorText(error)}`);
    }
  }
  return removed;
}

/**
 * Edge policies this worker depends on, re-asserted at every boot.
 *
 * Provisioning sets these, but provisioning runs once and policies drift — mine drifted because I set
 * `StartupBoostEnabled=1` on a guest to test an optimisation and could not verify whether it applied
 * (`utmctl exec` is unreliable in both directions, so "it seemed to fail" is not evidence it did). The
 * result was one guest carrying a resident Edge that its clones did not have.
 *
 * Enforcing them here makes the state self-healing rather than a thing somebody has to remember, and it
 * uses the only channel to these guests that actually works: push a file, reboot, verify over HTTP.
 *
 * `startup boost` keeps a browser process resident so launches feel fast; `background mode` does the
 * same for extensions. Both are wrong here — a capture spawns Edge, drives it, and quits it, and a
 * resident process only competes with that on a 2-vCPU guest.
 */
const REQUIRED_EDGE_POLICY = {
  StartupBoostEnabled: 0,
  BackgroundModeEnabled: 0,
};

/**
 * Report Edge policy drift. Does **not** try to correct it.
 *
 * It used to try, and printed two `Command failed: reg add HKLM\\...` lines on every single boot,
 * because the worker task is not elevated and `HKLM\\SOFTWARE\\Policies` needs admin. The write could
 * never succeed, so all it produced was two alarming red lines above a perfectly healthy
 * "the worker is ready" — and a console that cries wolf at every boot is a console people stop reading.
 *
 * Attempting an action you know you cannot perform is not robustness. Reporting the drift is: the value
 * is already served by `/diagnostics.edgePolicy`, `doctor` can compare it, and the thing that actually
 * fixes it — `provision-nvda-worker.ps1`, which runs elevated — is named in the message.
 *
 * @param {Record<string, number | null> | null} actual from diagnostics.edgePolicy()
 * @param {(line: string) => void} log
 * @returns {string[]} names of the settings that have drifted
 */
/**
 * @param {Record<string, unknown> | null | undefined} actual
 * @param {(message: string) => void} log
 * @returns {string[]}
 */
export function reportBrowserPolicyDrift(actual, log) {
  if (!actual) return [];
  // Carry the WANTED value alongside the name rather than re-indexing by it. Re-indexing needs a `keyof`
  // cast that `.map` over a `string[]` cannot supply, and the entries already hold both halves.
  const drifted = Object.entries(REQUIRED_EDGE_POLICY)
    .filter(([name, want]) => actual[name] !== null && actual[name] !== want);
  if (drifted.length) {
    log(`Edge policy drift: ${drifted.map(([name, want]) =>
      `${name}=${actual[name]} (want ${want})`).join(", ")}` +
      " — re-run scripts/provision-nvda-worker.ps1 on this guest to correct it (needs elevation).");
  }
  // The NAMES, which is what every caller uses — `drifted` carries the wanted values only so the message
  // above can print them without re-indexing.
  return drifted.map(([name]) => name);
}

/**
 * Kill browser processes left over from a previous worker.
 *
 * Safe **only** at boot. `captureWithNvda` closes the browser in a `finally`, so a stray at boot means the
 * previous worker died mid-capture or was killed — and those strays are what compound into
 * `nvda.start` timeouts.
 *
 * Takes the image name rather than assuming `msedge.exe`, and the caller passes the one image this guest
 * is configured for. It comes from the preset allow-list in `browsers.mjs`, never from a request — which
 * is what makes putting it on a `taskkill` command line safe.
 *
 * @param {{ count: number | null, image: string }} stray count from diagnostics.processCounts
 * @param {(line: string) => void} log
 */
export function killStrayBrowsers({ count, image }, log) {
  if (process.platform !== "win32" || !count) return false;
  log(`${count} orphaned ${image} process(es) at boot — a previous capture did not clean up; killing them`);
  try {
    execFileSync("taskkill", ["/im", image, "/f"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    // taskkill exits non-zero when nothing matched, which is a race we do not care about losing.
    return false;
  }
}

// #561: THE PROFILE CHANGES WHAT A CAPTURE SAYS, AND NOTHING KEYED IT.
//
// `environmentKey` keys on the screen reader, the driver, the browser, the OS, the protocol and the NVDA
// settings — every one of them because it changes what NVDA says before this project ever sees it. The
// profile belongs to that class and was not in it. This file's own header says why: a fresh
// `--user-data-dir` shows Edge's first-run welcome surface, and on a page with no headings NVDA's
// quick-nav escapes the empty document into that surface and records it as PHANTOM PAGE CONTENT. A cold
// profile does not merely differ from a warm one; it injects content that is not the page.
//
// The U+FFFC incident is the same variable measured: the autofill suggestion icon reached 3%, then 8%,
// then 31% of affected captures AS THE PROFILE LEARNED, because `probeForms` submits forms and the
// profile remembers. 26 good/bad pairs disagreed about it.
//
// ## `gate:stability` cannot close this, and the reason matters more than the fix
//
// That gate compares captures taken minutes apart WITHIN ONE RUN. A uniformly cold profile is perfectly
// stable — five cold captures agree with each other exactly. It caught U+FFFC only because the profile
// was WARMING during the run, a moving variable. Nothing compares evidence ACROSS runs, and that is the
// cache key's job. Reaching for the stability gate here would be a check that cannot express the fault.
//
// ## MISSING and CHANGED are different states, and conflating them recaptures the corpus
//
// On the day this ships every guest has a profile and no stamp. If that read as a CHANGED profile, every
// cached capture would miss at once — the `os`-key recapture paid a second time, for a field that has
// just been introduced and has told us nothing yet.
//
// So an unstamped profile that Edge has actually used is ADOPTED: it is stamped with the literal
// `adopted`, which is exactly what `environmentKey` defaults an absent field to. The key does not move.
// This is the same device `screenReaderSettings` uses with `"default"` — the absent value is a FACT
// ("this capture was taken at NVDA's defaults"), not an "unknown".
//
// A profile that is ABSENT, or present but never used, is not a survivor: it gets a fresh id and the key
// moves, which is the whole point.

/** What an adopted profile stamps and reports. Must equal `environmentKey`'s default for the field. */
export const ADOPTED_PROFILE = "adopted";

/**
 * Edge writes `Local State` into the profile root the first time it runs there. Its presence is what
 * separates "a profile that predates the stamp" from "a directory something just created" — without it,
 * an empty directory recreated by anything other than this code would be ADOPTED while being stone cold,
 * which is the one hole this design has and this is how it is closed.
 */
export const USED_MARKER = "Local State";

/**
 * #1201: WHAT PROVISIONING RECORDED, WHEN IT RECORDED ANYTHING.
 *
 * `ORIGIN_FILE` holds one of these two words, written by provisioning at the moment it knows the answer
 * rather than inferred afterwards from a file Edge happens to leave behind. Absent on every profile that
 * predates this, which is the case `USED_MARKER` still serves.
 */
export const ORIGIN_ADOPTED = "adopted-existing";
export const ORIGIN_FRESH = "created-fresh";

/** Where provisioning records what it did, beside the stamp it does not write. */
export const ORIGIN_FILE = ".a11y-profile-origin";

/**
 * PURE. Given what is on disk, what identity does this profile report and what must be written?
 *
 * #1201: ADOPTION IS A RECORDED FACT FIRST AND AN INFERENCE SECOND. It used to rest entirely on
 * `USED_MARKER` — a file Edge happens to write — so if Edge ever stopped writing it, every profile would
 * read as fresh and nothing would report the change. **The failure mode and the ordinary answer are the
 * same absence**, which is this repository's most expensive recurring shape.
 *
 * `recorded` is what provisioning wrote down at the time. When it is present it DECIDES, and the marker
 * becomes corroboration. When the two disagree that is a FINDING and is said out loud — a recorded
 * adoption whose profile has never been used, or a used profile provisioning called fresh, is one of the
 * two having been wrong, and resolving it silently in favour of either is how you stop being able to
 * tell. Precedence does not mean the loser goes unmentioned.
 *
 * @param {{ stamped: string | null, profileExists: boolean, hasBeenUsed: boolean, freshId: string,
 *           recorded?: string | null }} state
 *   `stamped` — the stamp file's contents, or null if there is none.
 *   `recorded` — `ORIGIN_FILE`'s contents, or null/undefined where provisioning recorded nothing.
 * @returns {{ identity: string, write: string | null, adopted: boolean, why: string,
 *             disagreement: string | null }}
 *   `write` is null when nothing needs stamping; `why` is the diagnostic mark's text, because
 *   "adopted an existing profile" and "stamped a new one" must never be the same silence.
 *   `disagreement` is non-null only when the record and the marker contradict each other.
 */
export function profileIdentity({ stamped, profileExists, hasBeenUsed, freshId, recorded = null }) {
  if (stamped) {
    return { identity: stamped, write: null, adopted: stamped === ADOPTED_PROFILE,
      why: `profile already stamped ${stamped}`, disagreement: null };
  }
  const disagreement = originDisagreement({ recorded, hasBeenUsed });
  if (recorded === ORIGIN_ADOPTED) {
    return { identity: ADOPTED_PROFILE, write: ADOPTED_PROFILE, adopted: true,
      why: `adopted an existing profile (provisioning recorded ${ORIGIN_ADOPTED}) -- the corpus was `
        + "taken against this profile, so the key must NOT move", disagreement };
  }
  if (recorded === ORIGIN_FRESH) {
    return { identity: freshId, write: freshId, adopted: false,
      why: `stamped a NEW profile: provisioning recorded ${ORIGIN_FRESH}`, disagreement };
  }
  // NO RECORD. Every profile provisioned before #1201 lands here, and so does any guest whose
  // provisioning did not run. The marker is the only witness left, which is the state this row narrows
  // rather than removes -- and the `why` says WHICH basis was used, so a reader of the diagnostic can
  // tell a recorded fact from an inference without reading this file.
  if (profileExists && hasBeenUsed) {
    return { identity: ADOPTED_PROFILE, write: ADOPTED_PROFILE, adopted: true,
      why: `adopted an existing profile (no provisioning record; ${USED_MARKER} present, so Edge has `
        + "run in it) -- the corpus was taken against this profile, so the key must NOT move",
      disagreement };
  }
  return { identity: freshId, write: freshId, adopted: false,
    why: profileExists
      ? `stamped a NEW profile: no provisioning record, and the directory has no ${USED_MARKER}, so `
        + "Edge has never run in it -- a cold profile, and cold evidence is not warm evidence"
      : "stamped a NEW profile: no provisioning record, and the directory did not exist",
    disagreement };
}

/**
 * The two sources contradicting each other, as a sentence, or null when they do not.
 *
 * Silent only when there is nothing to say: no record means nothing to contradict, and this deliberately
 * does NOT treat "recorded fresh, marker absent" as agreement worth reporting. Only a real contradiction
 * speaks, or the line becomes noise on every ordinary capture and stops being read.
 *
 * @param {{ recorded: string | null, hasBeenUsed: boolean }} state @returns {string | null}
 */
export function originDisagreement({ recorded, hasBeenUsed }) {
  if (recorded === ORIGIN_ADOPTED && !hasBeenUsed) {
    return `provisioning recorded ${ORIGIN_ADOPTED} but ${USED_MARKER} is absent -- either the profile `
      + "was wiped after provisioning, or Edge no longer writes that file. The record is being used; "
      + "the marker can no longer corroborate it";
  }
  if (recorded === ORIGIN_FRESH && hasBeenUsed) {
    return `provisioning recorded ${ORIGIN_FRESH} but ${USED_MARKER} is present -- Edge has run in a `
      + "profile provisioning created empty. The record is being used, and this profile's evidence is "
      + "warmer than the record claims";
  }
  return null;
}

/** Where the stamp lives, inside the profile root it identifies. */
export const STAMP_FILE = ".a11y-profile-id";

/**
 * #1201: what provisioning recorded, or null where it recorded nothing readable.
 *
 * Extracted because folding it into `readOrStampProfileIdentity` took that function to a complexity of
 * 16 against a limit of 15 -- and the rule reports at the DECLARATION, so a disable comment in the body
 * would have sat unused beside a live error. Splitting is the remedy this repo's conventions name.
 *
 * AN ORIGIN FILE THAT EXISTS AND CANNOT BE READ IS NOT AN ABSENT ONE. Returning null there is correct --
 * there is no record to use -- but doing it silently would put the decision back on `USED_MARKER` alone,
 * which is the single-witness state this row narrows. So the fallback is announced.
 *
 * @param {string} root @param {{ exists: (p: string) => boolean, read: (p: string) => string,
 *   log: (line: string) => void }} io @returns {string | null}
 */
function readRecordedOrigin(root, { exists, read, log }) {
  const originPath = join(root, ORIGIN_FILE);
  if (!exists(originPath)) return null;
  try {
    return read(originPath).trim() || null;
  } catch (cause) {
    log(`browser-profile: ${originPath} exists and could not be read: `
      + `${/** @type {Error} */ (cause).message} -- falling back to ${USED_MARKER} alone`);
    return null;
  }
}

/**
 * The profile's identity, stamping it if it has none. IDEMPOTENT: a stamped profile is only read.
 *
 * NOT MEMOISED, deliberately. `fileProductVersion` memoised on process lifetime and reported a stale
 * Edge version for five days while Edge updated underneath a running worker — captures were stamped with
 * a version they were not taken under, sharing a cache key with evidence from a different build. A
 * profile can be wiped under a running worker exactly as Edge can update under one, and the whole point
 * of this value is to notice. It is one small read on a polled endpoint; the memo is not worth the class
 * of bug it belongs to.
 *
 * @param {string} root the profile directory
 * @param {{ exists?: (p: string) => boolean, read?: (p: string) => string,
 *           write?: (p: string, body: string) => void, newId?: () => string,
 *           log?: (line: string) => void }} [deps]
 * @returns {{ identity: string, adopted: boolean, why: string }}
 */
export function readOrStampProfileIdentity(root, deps = {}) {
  const { exists = existsSync, read = (p) => readFileSync(p, "utf8"),
    write = (p, body) => writeFileSync(p, body), newId = () => randomUUID(), log = () => {} } = deps;
  const stampPath = join(root, STAMP_FILE);
  let stamped = null;
  if (exists(stampPath)) {
    try {
      stamped = read(stampPath).trim() || null;
    } catch (cause) {
      // A stamp we cannot read is NOT an absent one: adopting here would report a cold profile as the
      // corpus's own. Say so and let the caller decide, rather than guessing in the safe-looking
      // direction, which is how a silent catch once hid an outage in this repository.
      log(`browser-profile: ${stampPath} exists and could not be read: ${/** @type {Error} */ (cause).message}`);
      return { identity: "unreadable", adopted: false, why: `stamp present but unreadable at ${stampPath}` };
    }
  }
  const recorded = readRecordedOrigin(root, { exists, read, log });
  const decision = profileIdentity({
    stamped,
    profileExists: exists(root),
    hasBeenUsed: exists(join(root, USED_MARKER)),
    freshId: newId(),
    recorded,
  });
  // Said out loud, never folded into `why`: the identity is a decision and this is a finding about the
  // evidence behind it. A reader scanning for one must not have to parse the other.
  if (decision.disagreement !== null) {
    log(`browser-profile: SOURCES DISAGREE -- ${decision.disagreement}`);
  }
  if (decision.write !== null) {
    try {
      write(stampPath, decision.write);
    } catch (cause) {
      // The identity still stands for THIS capture; what is lost is that the next boot re-derives it.
      // Recorded rather than swallowed, and rather than failing a capture over a bookkeeping write.
      log(`browser-profile: could not stamp ${stampPath}: ${/** @type {Error} */ (cause).message}`);
    }
  }
  log(`browser-profile: ${decision.why}`);
  return { identity: decision.identity, adopted: decision.adopted, why: decision.why };
}
