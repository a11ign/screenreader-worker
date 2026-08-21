/**
 * Guest facts, over HTTP, because the guest agent cannot be relied on.
 *
 * Everything here was previously obtainable only through `utmctl exec`, which is a wrapper over QEMU's
 * `guest-exec`. That mechanism is **known-unreliable on Windows** — upstream has long-standing reports
 * of qemu-ga stopping at random across Windows and hypervisor versions, and of it failing to open
 * `\\.\Global\org.qemu.guest_agent.0` with "Access is denied" — and the standing advice to clients is to
 * assume it may simply not answer. Measured here across one session: it worked, then silently wrote
 * nothing, then returned OSStatus -2700, then worked again, on the same guest.
 *
 * A diagnostic channel that fails in the same way as the thing it diagnoses is worthless, which this
 * repo already learned once for the code hash: `/health.code` exists because reading the guest's files
 * back through `exec` returned *empty* rather than *mismatched* when `exec` was broken, and empty reads
 * as a flaky tool rather than a failed deploy. Same reasoning, wider scope.
 *
 * **Separate from `/health` on purpose.** `/health` is polled — by `worker-ctl.sh`, by the pool lease,
 * by `doctor` — so it must stay cheap. Walking an Edge profile of tens of thousands of files and
 * shelling out to `tasklist` is not cheap, so it lives behind its own endpoint and is only paid for when
 * somebody is actually diagnosing something.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statfsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALL_BROWSER_IMAGES } from "./browsers.mjs";

/** Stop walking a runaway tree. An Edge profile is large but not unbounded. */
const MAX_WALK_ENTRIES = 200_000;
const MAX_WALK_DEPTH = 12;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Total size and file count of a directory tree.
 *
 * Returns what it managed to measure rather than throwing: a diagnostic that fails must degrade to
 * "unknown", never take down the endpoint that reports it.
 *
 * @param {string} root
 * @returns {{ megabytes: number, files: number, truncated: boolean } | null}
 */
export function treeSize(root) {
  let bytes = 0, files = 0, truncated = false;
  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH || files >= MAX_WALK_ENTRIES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree (locked by Edge, most likely) -- skip it, keep the rest
    }
    for (const entry of entries) {
      if (files >= MAX_WALK_ENTRIES) { truncated = true; return; }
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      files += 1;
      try {
        bytes += statSync(path).size;
      } catch {
        // Vanished or locked between readdir and stat. Counting it as zero is honest enough.
      }
    }
  };
  try {
    statSync(root);
  } catch {
    return null; // absent, which is itself a fact worth reporting as null
  }
  walk(root, 0);
  return { megabytes: Math.round(bytes / BYTES_PER_MB), files, truncated };
}

/** Free and total space on the volume holding `path`, in MB, or null if unreadable. */
export function diskSpace(path) {
  try {
    const fs = statfsSync(path);
    return {
      freeMb: Math.round((fs.bsize * fs.bavail) / BYTES_PER_MB),
      totalMb: Math.round((fs.bsize * fs.blocks) / BYTES_PER_MB),
    };
  } catch {
    return null;
  }
}

/**
 * How many of each process are running.
 *
 * This is the fact that mattered most and was hardest to get: a leaked Edge is invisible from outside,
 * and eight orphaned msedge processes on a 4 GB guest is what once made every subsequent nvda.start time
 * out. One `tasklist` call for all of them, because spawning per name is what made this expensive.
 *
 * @param {string[]} names image names without `.exe`
 */
export function processCounts(names) {
  if (process.platform !== "win32") return null;
  try {
    const csv = execFileSync("tasklist", ["/fo", "csv", "/nh"], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 1 << 24,
    });
    const counts = {};
    for (const name of names) counts[name] = 0;
    for (const line of csv.split("\n")) {
      const image = /^"([^"]+)"/.exec(line)?.[1]?.replace(/\.exe$/i, "").toLowerCase();
      if (image && counts[image] !== undefined) counts[image] += 1;
    }
    return counts;
  } catch {
    return null;
  }
}

/**
 * What is actually using the guest's memory, largest first.
 *
 * Debloating an image on spec is guesswork. The guests are configured with 4,096 MB and use ~2,157 MB
 * mid-capture with Edge and NVDA up, and the question that decides whether a custom image is worth
 * building is what that 2,157 MB *is*: Windows services and background apps that a leaner image would
 * remove, or Edge and NVDA, which no image can remove because they are the job.
 *
 * One `tasklist` call, same as processCounts -- this endpoint is on-demand, so it can afford it.
 *
 * @param {number} limit how many processes to report
 */
export function topProcessesByMemory(limit = 15) {
  if (process.platform !== "win32") return null;
  try {
    return parseTasklistMemory(execFileSync("tasklist", ["/fo", "csv", "/nh"], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 1 << 24,
    }), limit);
  } catch {
    return null;
  }
}

/**
 * Group `tasklist /fo csv /nh` output by image name, largest first.
 *
 * Pure so it can be tested off Windows, which is where this repo runs its tests. The parsing is the part
 * that can quietly be wrong: the memory column is localised, thousands-separated and suffixed
 * (`"1,234 K"`), and Chromium reports a dozen processes under one image name — summing them is the whole
 * point, since "msedge = 900 MB across 9 processes" is the fact worth knowing.
 *
 * @param {string} csv
 * @param {number} limit
 */
export function parseTasklistMemory(csv, limit = 15) {
  /** @type {Record<string, {megabytes: number, count: number}>} */
  const byImage = {};
  for (const line of csv.split(/\r?\n/)) {
    const cells = line.match(/"([^"]*)"/g);
    if (!cells || cells.length < 5) continue;
    const name = cells[0].replaceAll('"', "");
    const kb = Number(cells[4].replaceAll(/[^\d]/g, ""));
    if (!Number.isFinite(kb) || !name) continue;
    const entry = byImage[name] ??= { megabytes: 0, count: 0 };
    entry.megabytes += kb / 1024;
    entry.count += 1;
  }
  return Object.entries(byImage)
    .map(([name, v]) => ({ name, megabytes: Math.round(v.megabytes), count: v.count }))
    .sort((a, b) => b.megabytes - a.megabytes)
    .slice(0, limit);
}

/**
 * Image names worth counting: the ones that have each caused an outage by leaking or dying.
 *
 * EVERY browser image, not just the configured one. This is a diagnostic, and the question it answers is
 * "what is actually running on this guest" — a Chrome guest with a stray Edge left by an earlier
 * configuration is exactly the thing a human reading /diagnostics needs to see. Killing is the narrow
 * operation (see `killStrayBrowsers`); counting is the wide one.
 */
const WATCHED_PROCESSES = [...ALL_BROWSER_IMAGES.map((i) => i.replace(/\.exe$/i, "")), "nvda", "node"];

/** The services the trim disables, plus Defender's, so their real state is visible after a trim. */
const TRIMMED_SERVICES = [
  "WSearch", "CrossDeviceService", "DiagTrack", "wuauserv", "UsoSvc", "WaaSMedicSVC",
  "WinDefend", "WdNisSvc",
];

/**
 * Everything a human would otherwise reach for `utmctl exec` to find out.
 *
 * @param {{ edgeProfile: string, logPath: string }} paths
 */
/**
 * Where a profile's bulk actually is, one level down.
 *
 * A total tells you the profile is big; it does not tell you what to do about it. Pruning the obvious
 * cache directories on a 511 MB profile recovered only 52 MB, which is exactly the kind of guess this
 * breakdown exists to prevent.
 */
/**
 * Committed bytes — how much memory the guest has actually *promised*, as opposed to how much it is
 * touching.
 *
 * This is the number that decides how much RAM a guest needs, and `topProcesses` is not. Summing
 * process working sets produces a figure in the same family as Windows' "in use", which includes the
 * file cache — and the file cache grows to fill whatever it is given. `create-utm-vm.sh` records the
 * measurement that makes the point: an 8 GB guest reported 3.5 GB "in use" and needed less than half
 * of it, while 4 GB and 8 GB guests produced byte-identical evidence at 165 s vs 167 s with zero
 * pagefile use on either. Size a guest from committed bytes or you will size it from its own cache.
 *
 * `commitLimit` is included because committed alone cannot say whether the guest is near trouble: the
 * limit is physical RAM plus the pagefile, and the ratio is the headroom.
 */
export function committedMemory() {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$m = Get-CimInstance Win32_PerfRawData_PerfOS_Memory; " +
      "Write-Output \"$($m.CommittedBytes) $($m.CommitLimit)\"",
    ], { encoding: "utf8", timeout: 30_000 });
    return parseCommittedMemory(output);
  } catch {
    return null;
  }
}

/**
 * Parse "<committedBytes> <commitLimit>" into MB. Pure, so it is testable off Windows.
 *
 * @param {string} output
 */
export function parseCommittedMemory(output) {
  const [committed, limit] = String(output).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(committed) || !Number.isFinite(limit) || limit <= 0) return null;
  const toMb = (bytes) => Math.round(bytes / (1024 * 1024));
  return {
    committedMb: toMb(committed),
    commitLimitMb: toMb(limit),
    usedShare: Math.round((committed / limit) * 100) / 100,
  };
}

/**
 * What the one-shot Windows trim did, if it has run on this guest.
 *
 * Served over HTTP because that is the only channel into a guest that is reliable: `utmctl exec`
 * returns success and no output whether or not it ran, and `file pull` needs a logged-on session. A
 * result you cannot read is a result you do not have.
 */
export function windowsTrimReport(markerPath = resolve(process.cwd(), ".windows-trimmed")) {
  for (const path of [`${markerPath}.json`, markerPath]) {
    try {
      const raw = readFileSync(path, "utf8");
      return path.endsWith(".json") ? JSON.parse(raw) : { summary: raw.trim() };
    } catch {
      continue; // not written yet, or still running -- try the plainer marker, then report absence
    }
  }
  return null;
}

/**
 * Normalise PowerShell's `ConvertTo-Json`, which emits a bare object for one result and an array for
 * several. Pure, because that inconsistency is a classic source of "works with two, breaks with one".
 *
 * @param {string} raw
 * @returns {object[]}
 */
/**
 * Everything a failed probe can tell us.
 *
 * `error.message` from execFileSync is just the command line; the actual complaint is on stderr, and
 * dropping it turns "Get-Service could not find X" into an unhelpful "Command failed". Learned by
 * losing a cycle to exactly that.
 */
export function probeError(error) {
  const stderr = String(error?.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(0, 4);
  return {
    error: String(error?.message ?? "").split("\n")[0].slice(0, 200),
    stderr: stderr.length ? stderr : undefined,
    status: error?.status,
  };
}

export function parsePowerShellJson(raw) {
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

/**
 * Defender's actual state, including whether Tamper Protection is on.
 *
 * `IsTamperProtected` is the field that decides a real architectural question. Defender is ~242 MB —
 * the largest single removable item on a capture guest — and if Tamper Protection is on, it cannot be
 * turned off from the running system at all: that is why tiny11 does it offline against a mounted
 * image. So this one boolean is the difference between "a registry write" and "own an ISO pipeline",
 * and it was being assumed rather than read.
 */
export function defenderState() {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-MpComputerStatus | Select-Object IsTamperProtected,RealTimeProtectionEnabled," +
      "AntivirusEnabled,AMRunningMode | ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 60_000 });
    return parsePowerShellJson(raw)[0] ?? null;
  } catch (error) {
    // Defender absent or the cmdlet blocked are both real answers; report the reason, do not guess.
    return probeError(error);
  }
}

/**
 * Status and start type of the services the trim disables.
 *
 * `sc.exe config start= disabled` does not stop a running service, so immediately after a trim these
 * read Running/Disabled — the saving only lands at the next boot. Reporting both fields is what makes
 * that distinction visible instead of looking like the trim silently failed.
 */
export function serviceStates(names = TRIMMED_SERVICES) {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-Service -Name ${names.join(",")} -ErrorAction SilentlyContinue | ` +
      "Select-Object Name,Status,StartType | ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 60_000 });
    return parsePowerShellJson(raw);
  } catch (error) {
    // Reported, never swallowed. A null here previously meant "threw, reason discarded", which read as
    // "no services found" and cost a debugging cycle: the trim looked like it had silently done nothing.
    return probeError(error);
  }
}

/**
 * The tail of the worker's own log.
 *
 * The trim writes its progress here, and a detached child that failed to start leaves its only trace
 * here too. `serverLog` already reported the file's SIZE, which answers "is it growing" and not "what
 * does it say" -- and the second question is the one you have when something did not happen.
 */
export function serverLogTail(logPath, lines = 40) {
  try {
    return readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch (error) {
    return { error: error.message.split("\n")[0].slice(0, 200) };
  }
}

/**
 * Who this process is and what UAC would let it become.
 *
 * The trim needs elevation and the worker has none, and the interesting question is whether that is a
 * hard wall or a solvable one. It turns entirely on facts that were being assumed:
 *
 *   - `isAdmin` -- is the account in Administrators at all? If not, nothing below matters.
 *   - `enableLUA` -- with UAC off, an admin's processes are already elevated and the trim would simply
 *     have worked, so its failure proves UAC is on OR the account is not an admin.
 *   - `consentPromptBehaviorAdmin` -- 0 means "elevate without prompting", in which case
 *     `Start-Process -Verb RunAs` elevates silently and a headless guest can self-elevate.
 *   - `promptOnSecureDesktop` -- a prompt here lands where nothing automated can answer it.
 *
 * Read-only. It reports what the machine is configured to allow; it does not change anything.
 */
export function privilegeState() {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "$id=[Security.Principal.WindowsIdentity]::GetCurrent();" +
      "$p=New-Object Security.Principal.WindowsPrincipal($id);" +
      "$sys='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';" +
      "$u=Get-ItemProperty $sys -ErrorAction SilentlyContinue;" +
      "$admins=try{(Get-LocalGroupMember -Group Administrators -ErrorAction Stop|" +
      "ForEach-Object{$_.Name}) -join ';'}catch{'unknown'};" +
      "[pscustomobject]@{user=$id.Name;" +
      "isElevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);" +
      "administrators=$admins;enableLUA=$u.EnableLUA;" +
      "consentPromptBehaviorAdmin=$u.ConsentPromptBehaviorAdmin;" +
      "promptOnSecureDesktop=$u.PromptOnSecureDesktop;" +
      "filterAdministratorToken=$u.FilterAdministratorToken}|ConvertTo-Json -Compress"],
      { encoding: "utf8", timeout: 60_000 });
    return parsePowerShellJson(raw)[0] ?? null;
  } catch (error) {
    return probeError(error);
  }
}

export function largestSubtrees(root, limit = 8) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const sized = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      sized.push({ name: entry.name, megabytes: treeSize(path)?.megabytes ?? 0 });
      continue;
    }
    try {
      sized.push({ name: entry.name, megabytes: Math.round(statSync(path).size / BYTES_PER_MB) });
    } catch { /* vanished between readdir and stat; nothing to report */ }
  }
  return sized.sort((a, b) => b.megabytes - a.megabytes).slice(0, limit);
}

/** The Edge policy values the worker depends on, read back so drift is visible over HTTP. */
export function edgePolicy() {
  if (process.platform !== "win32") return null;
  const read = (name) => {
    try {
      const out = execFileSync("reg",
        ["query", "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge", "/v", name],
        { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
      const hex = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)?.[1];
      return hex === undefined ? null : Number.parseInt(hex, 16);
    } catch {
      return null; // absent, which for a policy means "not set"
    }
  };
  return { StartupBoostEnabled: read("StartupBoostEnabled"), BackgroundModeEnabled: read("BackgroundModeEnabled") };
}

/** Tail of a text file, or null. Reading a log must never be able to break the endpoint. */
function tail(path, lines) {
  try {
    const all = readFileSync(path, "utf8").split(/\r?\n/);
    return { path, lines: all.length, tail: all.slice(-lines) };
  } catch {
    return null;
  }
}

/** The settings that decide whether NVDA can speak at all. Null when the file cannot be read. */
function readNvdaConfig(path) {
  try {
    const body = readFileSync(path, "utf8");
    return {
      path,
      synth: /^\s*synth\s*=\s*(.+)$/mi.exec(body)?.[1]?.trim() ?? null,
      speechViewer: /showSpeechViewerAtStartup\s*=\s*(\w+)/i.exec(body)?.[1] ?? null,
      outputDevice: /^\s*outputDevice\s*=\s*(.+)$/mi.exec(body)?.[1]?.trim() ?? null,
      bytes: body.length,
    };
  } catch {
    return null;
  }
}

/**
 * NVDA's own account of itself: its log and its configuration.
 *
 * The fault this is for: one guest's NVDA goes mute on every capture while its clones are fine, and
 * "mute" has several possible causes that look identical from outside — a broken speech synthesiser, an
 * add-on failing to load, a config that reset, a stub install. NVDA writes all of them to its log, and
 * nothing here could read it: `nvda.log` lives in the worker's own `%TEMP%`, and `utmctl exec` resolves
 * `$env:LOCALAPPDATA` to SYSTEM's profile, not the worker's — the runbook has a warning about exactly
 * that. Serving it over HTTP sidesteps the whole problem.
 *
 * `synth` is the first thing to compare between a healthy guest and a mute one: NVDA with a broken or
 * silenced synthesiser runs perfectly, answers every keystroke, and says nothing.
 */
export function screenReaderState({ nvdaRoot, tempDir, tailLines = 80 }) {
  const log = tail(join(tempDir, "nvda.log"), tailLines);
  // NVDA rotates its log on every start, so the CURRENT one is always the healthy instance that
  // replaced the broken one. The session that actually went mute is in `nvda-old.log`, and that is the
  // only place its dying words exist.
  const previous = tail(join(tempDir, "nvda-old.log"), tailLines);
  const configs = [];
  const findIni = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) findIni(path, depth + 1);
      else if (entry.name.toLowerCase() === "nvda.ini") {
        const parsed = readNvdaConfig(path);
        if (parsed) configs.push(parsed);
      }
    }
  };
  if (nvdaRoot) findIni(nvdaRoot, 0);
  // Errors and warnings are counted as well as shown: a log whose tail looks calm can still be full of
  // them further up, and the count is what makes two guests comparable at a glance.
  const body = log?.tail?.join("\n") ?? "";
  const previousBody = previous?.tail?.join("\n") ?? "";
  return {
    config: configs,
    log: log && { path: log.path, lines: log.lines, tail: log.tail },
    logErrors: (body.match(/^ERROR/gmi) ?? []).length,
    logWarnings: (body.match(/^WARNING/gmi) ?? []).length,
    previousLog: previous && { path: previous.path, lines: previous.lines, tail: previous.tail },
    previousLogErrors: (previousBody.match(/^ERROR/gmi) ?? []).length,
    previousLogWarnings: (previousBody.match(/^WARNING/gmi) ?? []).length,
  };
}

/**
 * WHAT ACTUALLY GOVERNS EDGE UPDATES ON THESE BOXES — the updater's tasks and services.
 *
 * `edgePolicy` above reports two Edge *browser* policies and has never reported the EdgeUpdate ones, and
 * for a while that looked like the gap. It is not. Microsoft documents twelve EdgeUpdate policies —
 * `UpdateDefault`, the per-app `Update{56EB18F8-…}` and `TargetVersionPrefix{…}` among them — as
 * "available only on Windows instances that are joined to a Microsoft Active Directory domain", and these
 * are standalone machines. Provisioning wrote `UpdateDefault=0`, the role read it back correctly, and
 * a11y-worker-2 updated itself from Edge .93 to .101 four days into a five-day uptime anyway.
 *
 * So reporting those policy values would have shown a green number for a control that was never in effect —
 * worse than reporting nothing, because `browserVersion` is a capture cache key and a fleet that silently
 * splits on it writes two evidence populations into one corpus.
 *
 * The scheduled tasks and services ARE the mechanism, because disabling them is what actually holds a
 * standalone box still (`roles/worker/tasks/edge-version.yml`). Reported, never re-applied: this endpoint
 * is a read, and the thing that fixes drift is the role, which runs elevated.
 *
 * **`tasksEnumerable` exists because the first version of this probe reported `tasks: []` on a guest with
 * two disabled tasks.** The worker is unelevated, so an empty list means either "there are none" or "this
 * process cannot see them" -- and those are opposite answers, one reassuring and one meaning the probe is
 * blind. Reporting them identically is the exact defect this endpoint is usually used to diagnose.
 */
export function edgeUpdaterState() {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      // Prefixed, because the set grows: a guest turned up carrying
      // `MicrosoftEdgeUpdateBrowserReplacementTask` alongside the two Machine tasks, `Ready` while they were
      // disabled. A name list cannot see a task nobody listed.
      "$t = @(Get-ScheduledTask -TaskName 'MicrosoftEdgeUpdate*' -ErrorAction SilentlyContinue |" +
      " Select-Object @{n='name';e={$_.TaskName}},@{n='state';e={[string]$_.State}});" +
      "$s = @(Get-Service -Name 'edgeupdate','edgeupdatem' -ErrorAction SilentlyContinue |" +
      " Select-Object @{n='name';e={$_.Name}},@{n='status';e={[string]$_.Status}},@{n='startType';e={[string]$_.StartType}});" +
      // AN EMPTY LIST IS NOT AN ANSWER HERE, and reporting it as one is the fault this whole endpoint keeps
      // being used to find. The worker runs unelevated, and on a box that demonstrably had two disabled
      // tasks this returned `tasks: []` -- which reads as "no updater tasks, all clear", the opposite of
      // the truth. So say which it is: enumerable-and-empty, or not enumerable by this process.
      "$readable = ($null -ne (Get-ScheduledTask -ErrorAction SilentlyContinue | Select-Object -First 1));" +
      "@{ tasks = $t; services = $s; tasksEnumerable = $readable } | ConvertTo-Json -Depth 4 -Compress"],
      { encoding: "utf8", timeout: 60_000 });
    return parsePowerShellJson(raw)[0] ?? null;
  } catch (error) {
    // An image without the updater at all is a real answer; so is a blocked cmdlet. Report the reason.
    return probeError(error);
  }
}

export function guestDiagnostics({ edgeProfile, logPath }) {
  return {
    measuredAt: new Date().toISOString(),
    edgePolicy: edgePolicy(),
    // The tasks and services, not just the policies — see `edgeUpdaterState` for why the policies cannot
    // answer this question on a machine that is not domain-joined.
    edgeUpdater: edgeUpdaterState(),
    edgeProfileBreakdown: largestSubtrees(edgeProfile),
    edgeProfileDefaultBreakdown: largestSubtrees(join(edgeProfile, "Default")),
    // The leading suspect for a slow worker: Edge is launched per capture, so its cold start is on the
    // critical path, and a Chromium profile that has accumulated cache stalls startup. Durable by
    // design (a fresh profile shows the first-run experience, which leaks into captures) -- durable is
    // not the same as unbounded, and this is how you tell the difference.
    edgeProfile: treeSize(edgeProfile),
    disk: diskSpace(edgeProfile),
    serverLog: treeSize(logPath),
    serverLogTail: serverLogTail(logPath),
    processes: processCounts(WATCHED_PROCESSES),
    topProcesses: topProcessesByMemory(),
    committedMemory: committedMemory(),
    windowsTrim: windowsTrimReport(),
    windowsTrimLog: serverLogTail(resolve(process.cwd(), ".windows-trimmed.log"), 30),
    defender: defenderState(),
    privileges: privilegeState(),
    services: serviceStates(),
    screenReader: screenReaderState({
      nvdaRoot: process.env.GUIDEPUP_SCREEN_READERS_PATH ||
        (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "guidepup") : null),
      tempDir: process.env.TEMP || process.env.TMP || ".",
    }),
  };
}
