// server.mjs — NVDA capture worker as an HTTP service.
// MUST run in an interactive desktop session (see run-server.cmd + the README).
//   POST /capture  { url, task?, steps?, probeForms?, probeFocus?, probeTables? }
//                                          -> { url, screenReader, transcript, task }
//   GET  /health                           -> { ok, screenReader, busy, code, environment }
// NVDA is a single shared resource, so captures are serialized.
import { createServer } from "node:http";
import { appendFileSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { freemem, totalmem, uptime as osUptime } from "node:os";
import { join, resolve } from "node:path";
import {
  browserAvailable, CAPTURE_PROTOCOL_VERSION, captureWithNvda, EDGE_PROFILE_DIR, forgetScreenReader,
  screenReaderSettings,
  screenReaderReady, shutdownScreenReader, warmUpScreenReader,
} from "./capture-core.mjs";
import { CAPTURE_HARD_TIMEOUT_DEFAULT_MS } from "./capture-pure.mjs";
import { isLocallyRecoverable } from "./worker-recovery.mjs";
import { codeVersion } from "./code-version.mjs";
import { listBlockingDialogs, dismissBlockingDialogs } from "./desktop-dialogs.mjs";
import { faultCode } from "./capture-faults.mjs";
import { edgePolicy, guestDiagnostics, processCounts, screenReaderState, treeSize } from "./diagnostics.mjs";
import { killStrayBrowsers, pruneEdgeProfile, reportBrowserPolicyDrift } from "./browser-profile.mjs";
import { applyRequestedLogLevel } from "./nvda-logging.mjs";
import { trimAlreadyDone } from "./windows-trim.mjs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.A11Y_PORT || 8765);
const LOG_PATH = process.env.A11Y_SERVER_LOG || "server.log";

// Log to the console AND the file, from here rather than by redirecting the launcher.
//
// The launcher used to send everything to server.log, which left the VM's console window
// blank: a worker mid-capture and a wedged worker look identical if neither prints anything,
// and a capture takes ~12s, which reads as a hang to anyone watching the guest.
//
// Doing it in-process rather than piping through PowerShell's Tee-Object, which on Windows
// PowerShell 5.1 has no -Encoding parameter and writes UTF-16 -- that changed the log's
// encoding mid-file and broke every existing reader of it.
function log(line) {
  const stamped = `${line}\n`;
  process.stdout.write(stamped);
  try {
    appendFileSync(LOG_PATH, stamped, "utf8");
  } catch {
    // Console output is the fallback; a failed append must not take the worker down.
  }
}

/** One generation kept. Enough to read the death of the previous worker, not enough to fill a disk. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;

/**
 * Roll `server.log` over at boot if it has grown too big.
 *
 * The log never rotated. It is appended to for the life of a guest, survives reboots by design (the
 * record of a worker's death is in the previous run's lines), and the guests have a 64 GB disk they
 * never otherwise fill — so this was a slow-motion outage nobody would notice until a capture failed
 * for a reason unrelated to accessibility.
 *
 * Done at BOOT and nowhere else, so it can never interleave with a capture's own logging.
 */
/**
 * Boot-time hygiene: bound the Edge profile and clear strays from a previous worker.
 *
 * At boot and nowhere else, because a capture owns Edge for its whole duration -- see
 * browser-profile.mjs for the measurements that made this necessary (a 511 MB profile and 5 orphaned
 * Edge processes on the slowest of three otherwise identical guests).
 */
const TRIM_MARKER = resolve(process.cwd(), ".windows-trimmed");

/**
 * Strip Windows' background services and apps, once per guest.
 *
 * Detached and unawaited on purpose. The work is minutes of synchronous PowerShell, and this worker has
 * to keep answering `/health` throughout -- `worker-ctl.sh up` and `worker:deploy` both gate on that
 * endpoint, so a blocking trim would look exactly like a failed deploy. The child writes the marker
 * itself, so an interrupted trim simply runs again next boot rather than half-recording success.
 *
 * Opt-out with A11Y_SKIP_TRIM=1 -- worth having on a guest being debugged, where an unattended process
 * removing operating-system components is one variable too many.
 */
function trimWindowsAtBoot() {
  if (process.platform !== "win32" || process.env.A11Y_SKIP_TRIM === "1") return;
  if (trimAlreadyDone(TRIM_MARKER)) return;
  try {
    const script = fileURLToPath(new URL("./windows-trim.mjs", import.meta.url));
    // Its output goes to a file, not /dev/null. A detached child with stdio "ignore" that dies on
    // startup leaves no trace anywhere, which is exactly how this failed silently on three boots.
    const out = openSync(`${TRIM_MARKER}.log`, "a");
    const child = spawn(process.execPath, [script, TRIM_MARKER],
      { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    log("windows trim started in the background (once per guest; see .windows-trimmed.json)");
  } catch (error) {
    // Trimming is an optimisation, never a precondition for serving captures.
    log(`windows trim could not start: ${error.message}`);
  }
}

async function tidyBrowserAtBoot() {
  try {
    reportBrowserPolicyDrift(edgePolicy(), log);
    // Opt-in, and at boot so it is in force before NVDA warms up. Unset by default: NVDA writes a lot at
    // DEBUG and this pipeline measures per-capture timing.
    applyRequestedLogLevel(
      (screenReaderState({
        nvdaRoot: process.env.GUIDEPUP_SCREEN_READERS_PATH ||
          (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "guidepup") : null),
        tempDir: process.env.TEMP || process.env.TMP || ".",
        tailLines: 1,
      }).config ?? []).map((c) => c.path), log);
    const strays = processCounts(["msedge"])?.msedge ?? 0;
    killStrayBrowsers(strays, log);
    // `treeSize` walks up to 200,000 directory entries SYNCHRONOUSLY, and the prune then deletes recursively.
    // Both ran inside the `listen` callback, so the port was bound while the event loop could not turn — the
    // worker accepted connections and answered none, which is indistinguishable from a dead one. Yielding
    // first is what makes the "hygiene is not a precondition for serving" comment below actually true: the
    // walk still costs what it costs, but `/health` can answer while it happens.
    await new Promise((resolve) => setImmediate(resolve));
    await pruneEdgeProfile(EDGE_PROFILE_DIR, treeSize(EDGE_PROFILE_DIR)?.megabytes ?? null, log);
  } catch (error) {
    // Hygiene is not a precondition for serving. Say what went wrong and carry on.
    log(`browser tidy-up at boot failed: ${error.message}`);
  }
}

function rotateLogIfLarge() {
  try {
    if (statSync(LOG_PATH, { throwIfNoEntry: false })?.size <= MAX_LOG_BYTES) return;
    renameSync(LOG_PATH, `${LOG_PATH}.1`); // replaces any previous generation
    log(`rotated ${LOG_PATH} (over ${MAX_LOG_BYTES} bytes); previous generation is ${LOG_PATH}.1`);
  } catch (error) {
    // A worker that cannot rotate its log must still serve. Say so and carry on.
    log(`could not rotate ${LOG_PATH}: ${error.message}`);
  }
}
let busy = false;

// Keep NVDA running between captures. Starting it costs ~5s, and this process serves many
// captures in a row.
//
// I turned this OFF for a while on the strength of a wrong conclusion, which is worth
// recording. A full run with reuse enabled produced markedly poorer evidence -- role words in
// 47% of phrases against 76% before, and "heading, level N" down from 105 to 15 -- so reuse
// looked like it was costing fidelity. It was not: the readiness gate landed in the same run
// and was overwriting the read-through's first line with the document title (see the
// re-anchor in capture-core). Two changes, one run, and a phrase COUNT that did not move, so
// neither the benchmark nor capture-check noticed.
//
// Measured properly afterwards, same 6 pages, gate fixed, one variable at a time:
//
//   reuse on:  29 phrases, 23 role words (79%), 8 "heading, level", 93s
//   reuse off: 29 phrases, 23 role words (79%), 8 "heading, level", 126s
//
// Identical evidence, 26% faster. capture-core recycles NVDA every 25 captures so a
// long-lived screen reader cannot drift unnoticed -- observed firing 3 times across 90
// captures. Set A11Y_REUSE_NVDA=0 for a fresh NVDA per capture, which remains the first thing
// to try if captures start behaving differently as a run progresses.
const REUSE_NVDA = process.env.A11Y_REUSE_NVDA !== "0";
const ENVIRONMENT_CACHE_MS = 5_000;

// Every probe is opt-in over the wire and defaults to off, so an old client keeps the old
// behaviour and no capture pays for a probe it did not ask for. Extracted from the handler
// because each default is a branch and the handler sat at the complexity ceiling.
// The worker reports its own code over the channel it serves on — see `code-version.mjs` for why that
// channel, and not `utmctl exec`. Wrapped here because a worker that cannot hash itself can still capture,
// and saying so beats refusing to start.
function reportedCodeVersion() {
  try {
    return codeVersion();
  } catch (e) {
    log(`could not compute code version: ${e.message}`);
    return "unknown";
  }
}

const CODE_VERSION = reportedCodeVersion();

const EDGE_EXES = [
  `${process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
];

/**
 * BOUNDED, because this is synchronous and `/health` depends on it.
 *
 * It had no timeout, and that is why this worker has repeatedly "looked dead": `execFileSync` blocks Node's
 * event loop for as long as the child runs, `/health` calls this for the Edge and NVDA version strings, and on
 * a guest where PowerShell was slow the loop stopped turning altogether. The port stayed open and nothing ever
 * answered — which reads as a hung worker rather than a blocked one, and sent this session chasing guest
 * memory, the browser and the screen reader in turn.
 *
 * Bounded is a mitigation, not the fix; the fix is the memo below, which keeps it off the polled path.
 */
const POWERSHELL_VALUE_TIMEOUT_MS = 5_000;

function powershellValue(script) {
  if (process.platform !== "win32") return "unknown";
  try {
    const value = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: POWERSHELL_VALUE_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
    return value || "unknown";
  } catch {
    // "unknown" rather than throwing: a version string we could not read must never take a worker offline.
    return "unknown";
  }
}

/**
 * Memoised for the life of the process, because an executable's version cannot change under a running worker.
 *
 * The environment cache was 5 seconds, so a polled `/health` re-shelled to PowerShell every 5 seconds to
 * re-read two version strings that are fixed at boot. That is the real defect: not that the call was slow, but
 * that a constant was being recomputed on the hottest path the worker has. Edge updating requires a restart
 * of Edge, and NVDA updating requires provisioning — both of which restart this process.
 */
const productVersions = new Map();

function fileProductVersion(path) {
  if (productVersions.has(path)) return productVersions.get(path);
  const escaped = path.replace(/'/g, "''");
  const version = powershellValue(`(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`);
  // Only a real answer is memoised. Caching "unknown" forever would make a transient PowerShell failure
  // permanent for the life of the worker, and the version is reported as evidence.
  if (version !== "unknown") productVersions.set(path, version);
  return version;
}

/**
 * Memoised, because this WALKS THE DISK and `/health` is polled.
 *
 * `currentEnvironment()` re-resolved the NVDA and Edge executables every 5 seconds, and the resolution is a
 * recursive synchronous directory walk. On a guest whose disk was busy that blocked Node's event loop, so the
 * worker stopped answering `/health` while remaining perfectly alive — the same shape as the unbounded
 * `execFileSync` above, from a different syscall. Neither executable moves under a running worker.
 */
const foundFiles = new Map();

function findFileMemo(root, wanted) {
  const key = `${root}\u0000${wanted}`;
  if (foundFiles.has(key)) return foundFiles.get(key);
  const found = findFile(root, wanted);
  // Only a hit is remembered: caching a miss forever would make a worker that started before NVDA was
  // installed report "unknown" for its whole life.
  if (found) foundFiles.set(key, found);
  return found;
}

function findFile(root, wanted, depth = 0) {
  if (!root || depth > 5 || !existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === wanted) return path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const found = findFile(join(root, entry.name), wanted, depth + 1);
    if (found) return found;
  }
  return null;
}

function packageVersion(name) {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve(`${name}/package.json`);
    return JSON.parse(readFileSync(packagePath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function runtimeEnvironment() {
  const guidepupRoot = process.env.GUIDEPUP_SCREEN_READERS_PATH ||
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "guidepup") : "");
  const nvdaPath = findFileMemo(join(guidepupRoot, "nvda"), "nvda.exe");
  const edgePath = EDGE_EXES.find((path) => existsSync(path));
  return {
    measuredAt: new Date().toISOString(),
    screenReader: "NVDA",
    screenReaderVersion: nvdaPath ? fileProductVersion(nvdaPath) : "unknown",
    browser: "Microsoft Edge",
    browserVersion: edgePath ? fileProductVersion(edgePath) : "unknown",
    guidepupVersion: packageVersion("@guidepup/guidepup"),
    nodeVersion: process.version,
    windowsVersion: powershellValue("$os = Get-CimInstance Win32_OperatingSystem; \"$($os.Caption) $($os.Version)\""),
    // The guest's architecture, from the worker process itself -- free, and no PowerShell round trip.
    // Part of the capture cache key: an ARM64 guest and an x64 one are different environments, and
    // without this the cache treats their evidence as interchangeable.
    architecture: process.arch,
    workerCode: CODE_VERSION,
    // What the evidence means, and what the host's capture cache keys on. See capture-core.mjs.
    captureProtocol: CAPTURE_PROTOCOL_VERSION,
    // Which provisioning built this guest. Written by provision-nvda-worker.ps1 rather than
    // hashed on the host, so it describes what the guest ACTUALLY has -- provisioning changes
    // NVDA's config, Edge's policies and ForegroundLockTimeout, all of which change the evidence.
    provisionRevision: provisionRevision(),
  };
}

// run-server.cmd changes into the checkout before starting Node, so resolve the stamp from the
// actual checkout rather than assuming the account is named `witness`. Prebuilt VMs and a manual
// bootstrap may use any Windows username; a hardcoded profile path silently turned every such
// worker into an `unstamped` cache environment.
const PROVISION_STAMP = resolve(process.cwd(), "provision-revision.txt");

function provisionRevision() {
  try {
    return readFileSync(PROVISION_STAMP, "utf8").trim() || "unstamped";
  } catch {
    // A guest provisioned before the stamp existed. Named rather than blank so a cache miss
    // caused by re-provisioning is explainable after the fact.
    return "unstamped";
  }
}

let environmentCache = null;
let environmentMeasuredAt = 0;

function currentEnvironment() {
  if (!environmentCache || Date.now() - environmentMeasuredAt > ENVIRONMENT_CACHE_MS) {
    environmentCache = runtimeEnvironment();
    environmentMeasuredAt = Date.now();
  }
  return environmentCache;
}

function captureOptions(parsed) {
  return {
    steps: parsed.steps,
    nav: parsed.nav,
    task: parsed.task ?? null,
    probeForms: parsed.probeForms ?? false,
    probeFocus: parsed.probeFocus ?? false,
    probeTables: parsed.probeTables ?? false,
    // Opt-in cross-check against NVDA's own Elements List totals. Opens a modal
    // dialog on the guest, so it is never on by default.
    probeElementsList: parsed.probeElementsList ?? false,
    // The worker default is deliberately fast, but callers running a provenance or
    // repeatability pass may require a fresh NVDA lifecycle for every capture. Keep this
    // opt-in at the request boundary so the host's environment cannot be mistaken for the
    // guest's process environment (A11Y_REUSE_NVDA on the host never reaches this process).
    // Per-request so browser reuse can be ISOLATED without editing the guest's scheduled task. Absent
    // means the fleet default (`A11Y_REUSE_BROWSER`), so nothing changes for callers that do not send it.
    reuseBrowser: typeof parsed.reuseBrowser === "boolean" ? parsed.reuseBrowser : undefined,
    reuseScreenReader: typeof parsed.reuseScreenReader === "boolean"
      ? parsed.reuseScreenReader
      : REUSE_NVDA,
  };
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// What this guest has done, and what it has left.
//
// "The workers degrade over time" was a hunch nobody could check, because /health described the
// ENVIRONMENT -- versions, NVDA up, lock timeout -- and said nothing about how hard the guest had been
// worked. A pool cannot manage a lifecycle it cannot measure, and every recycling threshold written
// without these numbers would be a guess.
//
// `recoveries` is the one to watch: it counts faults the worker papered over for the caller, so a
// worker whose recoveries climb is degrading even while every capture still succeeds. That is exactly
// the failure this pool has hidden before.
const worked = { captures: 0, failures: 0, recoveries: 0 };
// Consecutive recoveries, reset by any capture that needed none. Total recoveries accumulate
// legitimately over a long run; a RUN of them is the spiral worth breaking. See the circuit breaker in
// captureWithLocalRecovery.
const MAX_CONSECUTIVE_RECOVERIES = 3;
let consecutiveRecoveries = 0;

const MB = 1024 * 1024;

// os.freemem/os.uptime are syscalls, so this needs none of the caching foregroundLockTimeout() does.
function vitals() {
  return {
    uptimeMinutes: Math.round(osUptime() / 60),
    freeMemoryMb: Math.round(freemem() / MB),
    totalMemoryMb: Math.round(totalmem() / MB),
    ...worked,
  };
}

// ForegroundLockTimeout, read ONCE.
//
// Two reasons for the cache: PowerShell startup is ~0.5 s and /health is polled, and the value
// cannot change under us -- run-server.cmd applies it to this session before node starts and
// nothing else touches it for the worker's lifetime.
//
// It has to be read with SystemParametersInfo, not from the registry: the registry value is not
// what the session uses (that is the whole reason apply-foreground-lock-timeout.ps1 exists). Left
// non-zero, Edge is refused the foreground and every capture returns 0 phrases with no error.
const FLT_GET = 0x2000; // SPI_GETFOREGROUNDLOCKTIMEOUT
let fltCache;

function foregroundLockTimeout() {
  if (fltCache !== undefined) return fltCache;
  const raw = powershellValue(`
    Add-Type -Namespace W -Name Spi -MemberDefinition '
      [DllImport("user32.dll", SetLastError=true)]
      public static extern bool SystemParametersInfo(uint a, uint b, ref uint c, uint d);' | Out-Null
    $v = 0
    if ([W.Spi]::SystemParametersInfo(${FLT_GET}, 0, [ref]$v, 0)) { $v } else { "unknown" }`);
  const parsed = Number.parseInt(raw, 10);
  // null means "could not read", which must NOT block the worker: a broken diagnostic taking the
  // whole pool offline is worse than the fault it looks for. A value we DID read and dislike does
  // block.
  fltCache = Number.isFinite(parsed) ? parsed : null;
  return fltCache;
}

// Put the worker back in a usable state after a failed capture.
//
// An ABANDONED capture keeps running -- there is no way to kill it -- and it goes on driving NVDA and
// competing for the foreground. Measured: after two abandonments, the next captures on that worker
// hung in turn, on a host that was NOT CPU-saturated (493% of 1400% used). Stopping the screen reader
// is the one piece of the orphan we can reach; the next capture then cold-starts a clean one.
//
// Extracted from the request handler because the handler was at the complexity ceiling, and because
// "what we do after a failure" deserves a name.
async function recoverFromFailure(error) {
  forgetScreenReader();
  if (!/hard timeout/.test(String((error && error.message) || error))) return;
  log("abandoned capture may still be driving NVDA — stopping it so the next capture starts clean");
  await shutdownScreenReader().catch((e) => log("could not stop NVDA after abandonment: " + e.message));
}

// A capture that HANGS must not wedge the worker forever.
//
// This is the fault that made workers look dead for two days. `busy` is cleared in a `finally`,
// which only runs if the capture returns or throws -- so when one hung, `busy` stayed true and every
// later request got 429 "a capture is already in progress". From outside that is indistinguishable
// from a dead worker: /health answers, captures are all refused. Observed exactly:
//
//   capture 2/5 ... FAILED The operation was aborted due to timeout   <- client gave up
//   capture 3/5 ... FAILED a capture is already in progress           <- server never finished
//   capture 4/5 ... FAILED a capture is already in progress
//
// capture-core has its own budget (DEFAULT_BUDGET_MS) but it is checked BETWEEN phases, so a single
// guidepup call that never returns is unbounded. This is the backstop: above that budget, so the
// internal deadline still wins in the normal case.
//
// The abandoned capture cannot be killed -- it may still be waiting on NVDA -- so the screen reader
// is treated as untrustworthy afterwards and the next capture cold-starts one.
// startFreshScreenReader already knows how to clear a leftover instance out of the way.
// Default from the shared budget ladder in `capture-pure.mjs`, so it cannot drift below the capture
// budget it is supposed to contain — it was 240_000 against a budget of 120_000, and nothing checked.
const CAPTURE_HARD_TIMEOUT_MS =
  Number(process.env.A11Y_CAPTURE_HARD_TIMEOUT_MS || CAPTURE_HARD_TIMEOUT_DEFAULT_MS);

// One capture, plus one local recovery if the fault is one this worker can clear.
//
// The retry happens BEFORE the response, so a caller never sees a fault the guest could have fixed
// itself. capture-core stops the screen reader on any failure (`keepScreenReader` is false unless the
// capture succeeded), so the second attempt necessarily cold-starts a fresh NVDA -- which is precisely
// what made the next capture succeed when this was diagnosed by hand on two guests.
//
// See worker-recovery.mjs for why this is bounded at one attempt and why the hard timeout is excluded.
async function captureWithLocalRecovery(url, opts) {
  try {
    const clean = await withHardTimeout(captureWithNvda(url, opts));
    consecutiveRecoveries = 0;
    return clean;
  } catch (error) {
    if (!isLocallyRecoverable(error)) throw error;
    // CIRCUIT BREAKER. Recovering is bounded at one attempt PER CAPTURE, which worker-recovery.mjs
    // argued was enough not to become the restart loop that once wedged a guest. It is not: per-capture
    // is unbounded ACROSS captures, so a guest with a high fault rate restarts NVDA again and again.
    // Observed on a real run -- one guest reached 28 recoveries while its healthy peer sat at 0, and it
    // put `nvdaHelperRemote (injection_terminate)` on the desktop. A modal dialog BLOCKS INPUT, so the
    // next capture mutes, which triggers another recovery: the remedy feeding the fault it treats.
    //
    // `recoveries` was already counted here and read by nothing. Consecutive, not total: recovering ten
    // times across two thousand captures is a healthy guest meeting a stochastic fault, while three in a
    // row is a spiral. Refusing lets the fault surface as a real failure, which is what the run's own
    // `shouldRetireWorker` needs in order to retire this guest instead of watching it degrade.
    if (consecutiveRecoveries >= MAX_CONSECUTIVE_RECOVERIES) {
      log(`  refusing to restart NVDA again: ${consecutiveRecoveries} consecutive recoveries on this guest`);
      log("  failing the case so the run can retire this worker rather than restarting NVDA in a loop");
      throw error;
    }
    log(`  recoverable fault: ${(error && error.message) || error}`);
    log("  retrying once on a fresh screen reader rather than failing the caller's case");
    await recoverFromFailure(error);
    const result = await withHardTimeout(captureWithNvda(url, opts));
    worked.recoveries += 1;
    consecutiveRecoveries += 1;
    log(`  retry succeeded (${worked.recoveries} recovered on this guest, ${consecutiveRecoveries} in a row)`);
    return result;
  }
}

function withHardTimeout(promise) {
  let timer;
  const abandon = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`capture exceeded the hard timeout of ${CAPTURE_HARD_TIMEOUT_MS} ms and was abandoned`)),
      CAPTURE_HARD_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, abandon]).finally(() => clearTimeout(timer));
}

// Warm-up state. `error` is kept so a not-ready worker says WHY, which is the difference between
// "give it a moment" and "this guest is broken".
let warm = { ok: false, error: "not warmed up yet", at: null };
let warming = false;

async function warmUp(reason) {
  // One at a time. Readiness polling drives re-warms, and two concurrent NVDA starts would fight
  // over a single machine-wide screen reader.
  if (warming) return;
  warming = true;
  try {
    log(`warming up NVDA (${reason})`);
    const result = await warmUpScreenReader();
    warm = { ok: result.ok, error: result.error, at: new Date().toISOString() };
    // A success re-arms the budget: the next fault deserves its own three attempts.
    if (result.ok) warmAttempts = 0;
    log(result.ok
      ? "warm: NVDA is up and answering; the worker is ready"
      : `warm FAILED: ${result.error} — reporting not ready`);
  } finally {
    warming = false;
  }
}

// Warm up ONCE, and never again while idle.
//
// The aggressive version of this was actively destructive, and the guest console showed it:
//
//     NVDA is up and answering; the worker is ready
//     warming up NVDA (retry 1/3 while not ready)
//     NVDA is up and answering; the worker is ready
//     warming up NVDA (retry 1/3 while not ready)      <- forever, always "1/3"
//
// Always 1/3 because a success reset the attempt budget, so the cap never accumulated -- the
// cooldown limited the RATE of NVDA restarts, not the fact of them. And restarting NVDA repeatedly
// makes it put up a MODAL dialog on the guest desktop ("nvdaHelperRemote (injection_terminate):
// Error waiting for local thread to die"), which blocks input. That is what hung captures, which is
// what wedged `busy`, which is what made workers look dead. One VM took QEMU down with it.
//
// The deeper error was treating a live NVDA as a PRECONDITION. It is not: startScreenReader already
// probes NVDA and cold-starts a fresh one when it has gone (the `nvdaGone` path), so a capture
// succeeds whether or not NVDA is up right now. Warming at boot only moves that cost off the first
// capture -- a nicety, not a requirement -- so it is done once, with a bounded retry, and then the
// worker leaves NVDA alone. Idle workers must not touch the screen reader.
const MAX_WARM_ATTEMPTS = 3;
const WARM_RETRY_COOLDOWN_MS = 30_000;
let warmAttempts = 0;
let lastWarmAttempt = 0;

function warmUpOnceIfNeeded() {
  if (warm.ok || warming) return;                                 // already warm, or in flight
  if (warmAttempts >= MAX_WARM_ATTEMPTS) return;                  // gave up; say so, do not thrash
  if (Date.now() - lastWarmAttempt < WARM_RETRY_COOLDOWN_MS) return;
  lastWarmAttempt = Date.now();
  warmAttempts += 1;
  warmUp(`boot warm-up ${warmAttempts}/${MAX_WARM_ATTEMPTS}`)
    .catch((e) => log("warm-up threw: " + e.message));
}

/**
 * The last observed state of the desktop, sampled in the BACKGROUND.
 *
 * `/health` is polled by `worker-ctl.sh`, the pool lease and `doctor`, and it must never wait on a child
 * process — the first version of this called PowerShell from inside the readiness path and `/health` stopped
 * answering at all, which is the same defect `/diagnostics` has. So a timer samples, and the request only ever
 * reads memory. `dialogs: null` means "not sampled yet", which is deliberately NOT a failure: an unreadable
 * diagnostic must not take a worker offline, the rule `foregroundLockTimeout` already follows.
 */
let dialogCache = { at: 0, dialogs: null };

async function sampleDesktopDialogs() {
  const dialogs = await listBlockingDialogs((reason) => log(`could not enumerate desktop dialogs: ${reason}`));
  dialogCache = { at: Date.now(), dialogs };
  if (dialogs.length) {
    log(`  desktop is blocked by ${dialogs.length} dialog(s): `
      + dialogs.map((d) => `${d.title}: ${d.message}`).join(" | "));
  }
}

// NOT on a timer. The first version sampled every 30 s, and on a 3 GB guest that is a PowerShell process
// compiling C# on a repeating schedule — measured timing out at 8 s, then still at 25 s, on a guest already
// starved by Edge. A detector that loads the machine it is watching makes the condition it looks for more
// likely, which is the opposite of a diagnostic. The sample that matters is the one at the START OF A CAPTURE,
// where a dialog actually blocks work and where the cost is paid once; `/health` reports whatever that last
// sample saw, and says how old it is rather than pretending to be current.
void sampleDesktopDialogs();

async function readiness() {
  warmUpOnceIfNeeded();
  const dialogs = dialogCache.dialogs;
  const checks = {
    // REPORTED, not gated on. A capture cold-starts NVDA when it has gone, so an idle worker with
    // no NVDA is still able to take work -- and gating on it caused the restart loop above.
    screenReader: await screenReaderReady(),
    browser: browserAvailable(),
    // Applied per session by run-server.cmd. Left non-zero, Edge is refused the foreground and
    // every capture returns 0 phrases with NO error at all -- the worst failure mode we have.
    foregroundLockTimeout: foregroundLockTimeout(),
    // A modal dialog blocks INPUT, so it blocks every capture — and unlike a slow guest it never clears
    // itself. Gated on, and it is the only NVDA-adjacent condition that is: the remedy here is closing a
    // window rather than restarting NVDA, so this cannot rebuild the restart loop the comment below warns
    // about. `null` until the first sample lands, and null never fails the gate.
    noBlockingDialog: dialogs === null ? null : dialogs.length === 0,
    warmedUp: warm.ok,
  };
  // What actually PREVENTS a capture.
  //
  // Nothing about NVDA gates readiness. Both `screenReader` and `warmedUp` are REPORTED, because a
  // capture starts its own screen reader (with its own retry) and succeeds whether or not one is up
  // beforehand. Gating on them produced the two worst behaviours of this worker: a restart loop that
  // put modal dialogs on the guest desktop, and -- once warm-up gave up -- a healthy guest sidelined
  // for the rest of the session over an optimisation it did not need.
  //
  // Readiness is about the ENVIRONMENT: is there a browser, can it take the foreground, are we free.
  const failed = Object.entries(checks)
    .filter(([name, value]) => {
      if (name === "screenReader" || name === "warmedUp") return false;
      // A number: 0 is good, non-zero is bad, null is unreadable and deliberately not a failure
      // (a broken diagnostic must not take a worker offline -- see foregroundLockTimeout()).
      if (name === "foregroundLockTimeout") return typeof value === "number" && value !== 0;
      // Not sampled yet is not a fault — same reasoning as foregroundLockTimeout's unreadable case.
      if (name === "noBlockingDialog") return value === false;
      return !value;
    })
    .map(([name]) => name);
  return {
    ready: failed.length === 0 && !busy,
    checks,
    // Not an error when it is merely busy: a worker mid-capture is healthy, just not free.
    // Warm-up trouble is worth surfacing even when it does not block work: a worker capturing
    // without a warm NVDA is slower on its first case, and that is useful to know.
    // The dialog's own text, because "not ready: noBlockingDialog" would name the check and not the fault.
    // The specimen this was built for said "Couldn't terminate existing NVDA process ... Access is denied",
    // which tells you an orphaned NVDA is the cause; the check name tells you nothing.
    blockingDialogs: (dialogs ?? []).map((d) => ({ title: d.title, message: d.message })),
    // Age, because this is sampled at capture start rather than continuously: "no dialogs, as of 40 minutes
    // ago" is a different claim from "no dialogs now", and conflating them is how a stale check reads as a
    // fresh one.
    dialogsCheckedMsAgo: dialogCache.at ? Date.now() - dialogCache.at : null,
    reason: failed.length ? `not ready: ${failed.join(", ")}`
      + (dialogs?.length ? ` — desktop blocked by: ${dialogs.map((d) => d.message || d.title).join(" / ")}` : "")
      : busy ? "busy with a capture"
        : warm.ok ? null : `ready, but not warmed up (${warm.error})`,
  };
}

/**
 * The worker's whole HTTP surface: three routes, dispatched here and answered one level down.
 *
 * A function that ONLY routes is where a chain of `if`s belongs — the request shape is the thing being
 * branched on, it happens in exactly one place, and each route is a function so it can do one thing. This IS
 * the API of the package (`CAPTURE_PROTOCOL_VERSION` versions it, not semver), so keeping the surface readable
 * at a glance matters more here than anywhere else in the worker.
 */
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return respondWithHealth(res);
  if (req.method === "GET" && req.url === "/progress") return respondWithProgress(res);
  if (req.method === "GET" && req.url === "/diagnostics") return respondWithDiagnostics(res);
  if (req.method === "POST" && req.url === "/capture") return acceptCaptureRequest(req, res);
  send(res, 404, { error: "not found" });
});

/**
 * What is the running capture doing RIGHT NOW? Cheap by contract, like `/health`.
 *
 * Deliberately NOT part of `/diagnostics`, which walks the Edge profile and shells out to `tasklist` — that
 * endpoint is expensive enough to be unusable on a loaded guest, which is exactly when you need this. Reading
 * an array that is already in memory cannot hang, so this answers whenever the event loop turns at all.
 */
function respondWithProgress(res) {
  if (!inFlight) return send(res, 200, { busy, capturing: null });
  const marks = inFlight.marks;
  const last = marks.length ? marks[marks.length - 1] : null;
  send(res, 200, {
    busy,
    capturing: inFlight.url,
    startedAt: inFlight.startedAt,
    elapsedMs: Date.now() - Date.parse(inFlight.startedAt),
    // The phase it is IN is the one after the last completed mark, so report the last mark and its age:
    // a phase that has been current for four minutes is the one that is hanging.
    lastPhase: last && last.event,
    lastPhaseAtMs: last && last.atMs,
    phases: marks.map((m) => ({ event: m.event, atMs: m.atMs })),
  });
}

/** Cheap by contract: this is polled, so nothing here may walk a disk or shell out. */
function respondWithHealth(res) {
  const environment = currentEnvironment();
  // `ok` is kept for older callers and still means "the HTTP server is answering". `ready` is
  // the one to dispatch on -- see readiness().
  return readiness().then((state) => send(res, 200, {
    ok: true,
    ready: state.ready,
    vitals: vitals(),
    readiness: state,
    screenReader: environment.screenReader,
    busy,
    code: CODE_VERSION,
    environment,
  })).catch((e) => send(res, 500, { error: String((e && e.message) || e) }));
}

/**
 * On-demand guest facts. Deliberately NOT part of /health, which is polled and must stay cheap: this one
 * walks the Edge profile and shells out to tasklist. See diagnostics.mjs for why it exists at all -- the
 * guest agent that used to answer these questions cannot be relied on.
 */
function respondWithDiagnostics(res) {
  try {
    return send(res, 200, {
      ...guestDiagnostics({ edgeProfile: EDGE_PROFILE_DIR, logPath: LOG_PATH }),
      screenReaderSettings: screenReaderSettings(),
    });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
}

/**
 * Read the request, validate it, and hand a well-formed capture on.
 *
 * NVDA is ONE machine-wide resource, so a second concurrent capture cannot be queued, only refused.
 *
 * **`busy` is claimed in the same synchronous step as the check, and that is the whole point.** It used to be
 * checked here and set later, inside `runCapture` — with the body-read callback in between. Node does not
 * preempt mid-statement, so a synchronous check-then-set is atomic; a check and a set separated by an `await`
 * boundary is not. Two requests arriving close together both saw `busy === false`, both read their bodies, and
 * both drove the same NVDA. That does not fail loudly: it produces two captures interleaved on one screen
 * reader, which is contaminated evidence rather than an error, and the pool would never notice.
 *
 * Reachable in practice even though the pool sends one case per worker: CLAUDE.md records that two shells or
 * two agents drive this worker, and a `--no-cache` rerun beside a live run is exactly the shape.
 *
 * Claiming earlier buys a new hazard, so it is handled: a request that dies before `end` would hold `busy`
 * forever, which is the "wedged worker" that once cost two days of misdiagnosis. `releaseOnAbandon` covers it.
 */
function acceptCaptureRequest(req, res) {
  if (busy) return send(res, 429, { error: "a capture is already in progress" });
  busy = true;
  let body = "";
  releaseOnAbandon(req);
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let parsed;
    try { parsed = JSON.parse(body || "{}"); }
    catch { busy = false; return send(res, 400, { error: "invalid JSON body" }); }
    if (!parsed.url) { busy = false; return send(res, 400, { error: "url is required" }); }
    await runCapture(res, parsed.url, captureOptions(parsed));
  });
}

/**
 * Release the slot if the request never reaches `end`.
 *
 * A client that disconnects mid-body would otherwise leave `busy` set with no capture running and nothing to
 * time out — a worker that answers /health, reports ready, and 429s every capture forever. That is precisely
 * the wedge this project misdiagnosed as a dead machine, arrived at from the other direction.
 */
function releaseOnAbandon(req) {
  let finished = false;
  req.once("end", () => { finished = true; });
  for (const event of ["aborted", "error", "close"]) {
    req.once(event, () => {
      if (finished) return;
      log(`  capture request ${event} before its body arrived; releasing the slot`);
      busy = false;
    });
  }
}

/**
 * The capture currently running, if any — the live view behind `/progress`.
 *
 * A capture is the only long operation this worker performs, and until now it was completely opaque while it
 * ran: the phase marks existed but were unreachable until the response, so a capture that hung for five
 * minutes and then died told you only that it had died. Watching a real website fail was what made that
 * unacceptable — the question "which phase?" had no answer available at any price.
 */
let inFlight = null;

/** Drive one capture and answer with it. `busy` was claimed by the caller and is released here. */
async function runCapture(res, url, opts) {
  const startedAt = new Date().toISOString();
  log(`[${startedAt}] capture ${url} (nav=${opts.nav || "object"}, probeForms=${opts.probeForms}, probeFocus=${opts.probeFocus})`);
  // Ours, not the capture's, so an abandoned capture cannot take its own evidence down with it, and
  // `/progress` can read it WHILE the capture runs.
  const marks = [];
  inFlight = { url, startedAt, marks };
  // Clear the desktop BEFORE driving it. A modal dialog left by an earlier failure swallows every keystroke
  // this capture is about to send, so the capture would run its full budget and be abandoned with no
  // explanation — which is precisely what happened repeatedly before this existed. Recorded as a mark rather
  // than done silently, because a remedy that leaves no trace is how a recurring fault stays invisible.
  const cleared = await dismissBlockingDialogs((reason) => log(`could not dismiss desktop dialogs: ${reason}`));
  if (cleared.dismissed.length) {
    log(`  dismissed ${cleared.dismissed.length} blocking dialog(s) before capturing: `
      + cleared.dismissed.map((d) => `${d.title}: ${d.message}`).join(" | "));
    marks.push({ event: "desktopDialogsDismissed", atMs: 0, dialogs: cleared.dismissed });
    // The cached readiness answer is now stale, and the next poll should see a clear desktop.
    dialogCache = { at: Date.now(), dialogs: [] };
  }
  try {
    const result = await captureWithLocalRecovery(url, { ...opts, diagnosticsSink: marks });
    const environment = currentEnvironment();
    const after = (result.diagnostics || []).find((e) => e.event === "afterStart");
    log(`  -> ${result.transcript.length} phrases; afterStart.lastSpoken=${JSON.stringify(after && after.lastSpoken)}`);
    if (result.transcript.length === 0) {
      log("  WARNING: 0 phrases. If afterStart.lastSpoken is empty, NVDA is running but not speaking — restart/reboot the worker.");
    }
    worked.captures += 1;
    send(res, 200, {
      ...result,
      screenReader: environment.screenReader,
      task: opts.task,
      environment,
    });
  } catch (e) {
    worked.failures += 1;
    log("  capture failed: " + ((e && e.stack) || e));
    // `fault` is additive on the wire: an older host ignores it and keeps matching on `error`,
    // a newer one can classify without parsing prose. See capture-faults.mjs for why that matters.
    // The phases it DID complete, so a caller can see where it stopped. Without this a hung capture
    // reports only "exceeded the hard timeout", which names the symptom and nothing else — and the marks
    // that would name the phase were being discarded with the abandoned capture.
    const reached = marks.length ? marks[marks.length - 1] : null;
    if (reached) log(`  reached phase '${reached.event}' at ${reached.atMs}ms, ${marks.length} mark(s)`);
    send(res, 500, {
      error: String((e && e.message) || e),
      fault: faultCode(e),
      diagnostics: marks,
      reachedPhase: reached && reached.event,
    });
    // A capture that died may have left NVDA unusable. Stop claiming readiness and try to get
    // back to it, rather than accepting the next case and failing that one too.
    // Deliberately NOT re-warmed here. The next capture's startScreenReader probes NVDA and
    // cold-starts a fresh one if needed, which is the same work at a safer moment; warming now
    // would restart NVDA while the guest may still have a modal dialog up from the failure.
    await recoverFromFailure(e);
  } finally {
    busy = false;
  }
}

server.listen(PORT, () => {
  rotateLogIfLarge();
  log(`a11y-witness NVDA worker listening on :${PORT} (reuse NVDA: ${REUSE_NVDA})`);
  // Hygiene AFTER the log line and deliberately not awaited, for the same reason warm-up is not: a caller
  // must see "not ready yet" rather than silence. These used to run BEFORE the log, synchronously, which is
  // why a guest with a large Edge profile reported NOT ready for three minutes after every deploy.
  void tidyBrowserAtBoot().catch((e) => log("browser tidy-up threw: " + e.message));
  trimWindowsAtBoot();
  // Deliberately not awaited: the port must answer immediately so callers can see "not ready yet"
  // instead of a connection refusal, which reads as a dead worker.
  warmUp("worker start").catch((e) => log("warm-up threw: " + e.message));
});

// An NVDA socket error arrives asynchronously, outside the request handler that caused it,
// so it lands here as an uncaught exception. Without this the worker dies with a bare stack
// trace -- which is exactly what happened when another process stopped the NVDA this one was
// reusing: `Cannot connect to NVDA / ECONNREFUSED 127.0.0.1:6837`, task result 1, no worker.
//
// Exit deliberately non-zero rather than trying to soldier on: the screen reader's state is
// unknown at this point, and a worker that keeps answering /health while unable to capture is
// worse than one that is honestly gone. The scheduled task is configured to restart it.
// A dropped NVDA speech channel is RECOVERABLE and must not kill the worker.
//
// Guidepup reports it asynchronously on its own socket, so it arrives as an unhandled
// rejection: "Cannot connect to NVDA", "connect ECONNREFUSED 127.0.0.1:6837". This used to
// exit(1) on the theory that the scheduled task would restart a clean worker. It does not
// reliably do that -- observed: a worker exited on exactly this error and was still dead three
// minutes later with its VM up and RestartCount 5 configured, and only came back when restarted
// by hand. Exiting therefore traded a recoverable fault for a dead worker.
//
// Now the worker forgets the reused NVDA and keeps serving; the next capture cold-starts one.
const RECOVERABLE = /Cannot connect to NVDA|ECONNREFUSED[\s\S]*6837/i;

/**
 * Socket errnos that mean "the NVDA speech channel went away", which is EXPECTED and must never be fatal.
 *
 * Node's own `error.code`, not prose — the rule `capture-faults.mjs` already establishes for capture faults,
 * applied here where it was missing. The regex above could not match what actually happens: stopping NVDA
 * after an abandoned capture resets the TLS socket to NVDA Remote, Node reports `read ECONNRESET` from
 * `TLSWrap.onStreamRead`, and that stack contains neither "Cannot connect to NVDA" nor the port 6837 the
 * second branch requires. So the worker exited, and the guest then sat there answering nothing — which is the
 * "the worker is dead" symptom this project keeps re-diagnosing. It was a text match that could not
 * discriminate, exactly as the fault-code rule warns.
 *
 * A reset socket is never a reason to take a worker out of service: `forgetScreenReader()` drops the stale
 * handle and the next capture cold-starts a clean NVDA, which is work it was going to do anyway.
 */
const RECOVERABLE_SOCKET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT"]);

for (const fatal of ["uncaughtException", "unhandledRejection"]) {
  process.on(fatal, (error) => {
    const detail = (error && error.stack) || String(error);
    log(`${fatal}: ${detail}`);
    if (RECOVERABLE_SOCKET_CODES.has(error?.code) || RECOVERABLE.test(detail)) {
      forgetScreenReader();
      log("NVDA speech channel lost — forgetting it and staying up; the next capture cold-starts NVDA");
      return;
    }
    log("exiting so the scheduled task can restart a clean worker");
    process.exit(1);
  });
}

// A reused NVDA outlives the capture that started it, so it has to be stopped when this
// process goes away -- otherwise the scheduled task restarts the worker into a machine that
// already has a screen reader running, which is how the speech channel destabilises.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    log(`${signal}: stopping NVDA before exit`);
    await shutdownScreenReader();
    process.exit(0);
  });
}
