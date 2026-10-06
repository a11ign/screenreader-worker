// Parsing `tasklist` output decides what we believe is using the guest's memory — and that number is
// about to decide whether we build a custom Windows image. Worth being sure it is read correctly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTasklistMemory } from "./diagnostics.mjs";

// Real `tasklist /fo csv /nh` shape: image, pid, session name, session #, mem usage.
const CSV = [
  '"msedge.exe","6816","Console","1","512,340 K"',
  '"msedge.exe","6820","Console","1","300,100 K"',
  '"nvda.exe","4912","Console","1","102,400 K"',
  '"node.exe","3120","Console","1","51,200 K"',
].join("\r\n");

test("processes are grouped by image and summed, largest first", () => {
  // Chromium reports many processes under one name; the useful fact is the total, not any one of them.
  const top = parseTasklistMemory(CSV);
  assert.equal(top[0].name, "msedge.exe");
  assert.equal(top[0].count, 2);
  assert.equal(top[0].megabytes, 793, "512,340 K + 300,100 K = ~793 MB");
  assert.deepEqual(top.map((p) => p.name), ["msedge.exe", "nvda.exe", "node.exe"]);
});

test("the thousands-separated, K-suffixed memory column is read correctly", () => {
  // "102,400 K" is 100 MB. Reading it as 102400 MB or 102 MB would both look plausible in a report.
  assert.equal(parseTasklistMemory(CSV).find((p) => p.name === "nvda.exe")!.megabytes, 100);
});

test("the limit is honoured", () => {
  assert.equal(parseTasklistMemory(CSV, 2).length, 2);
});

test("junk lines are skipped rather than poisoning the totals", () => {
  const noisy = ['INFO: no tasks', '', '"bad.exe","1","Console","1"', CSV].join("\r\n");
  const top = parseTasklistMemory(noisy);
  assert.ok(!top.some((p) => p.name === "bad.exe"), "a row with no memory column is not a process");
  assert.equal(top[0].megabytes, 793, "valid rows still total correctly");
});

test("empty output is an empty list, not a crash", () => {
  assert.deepEqual(parseTasklistMemory(""), []);
});

// Committed bytes is what a guest's RAM should be sized from. Working-set sums include the file
// cache, which grows to fill whatever the guest is given — so reading this wrong sizes a VM from its
// own cache. See create-utm-vm.sh: an 8 GB guest reported 3.5 GB "in use" and needed under half.
import { parseCommittedMemory } from "./diagnostics.mjs";

test("committed bytes and the commit limit are reported in MB with their ratio", () => {
  // 2 GiB committed against a 6 GiB limit.
  const m = parseCommittedMemory("2147483648 6442450944")!;
  assert.equal(m.committedMb, 2048);
  assert.equal(m.commitLimitMb, 6144);
  assert.equal(m.usedShare, 0.33);
});

test("trailing newlines and CRLF from PowerShell do not break the parse", () => {
  assert.equal(parseCommittedMemory("2147483648 6442450944\r\n")!.committedMb, 2048);
});

test("unparseable or zero-limit output is null, never a divide-by-zero", () => {
  for (const bad of ["", "not numbers", "2147483648", "2147483648 0"]) {
    assert.equal(parseCommittedMemory(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// PowerShell's ConvertTo-Json emits a bare object for one result and an array for several. Reading a
// service list that happens to have one entry must not silently become "no services".
import { parsePowerShellJson } from "./diagnostics.mjs";

test("a single PowerShell result is normalised to a one-element array", () => {
  const one = parsePowerShellJson('{"Name":"WSearch","Status":4,"StartType":4}');
  assert.equal(one.length, 1);
  assert.equal((one[0] as { Name: string }).Name, "WSearch");
});

test("several results stay an array", () => {
  const many = parsePowerShellJson('[{"Name":"WSearch"},{"Name":"DiagTrack"}]');
  assert.equal(many.length, 2);
});

test("empty or non-JSON output is an empty list, never a throw", () => {
  // Get-Service with -ErrorAction SilentlyContinue prints nothing when no service matches.
  for (const bad of ["", "   ", "Get-Service : Cannot find any service"]) {
    assert.deepEqual(parsePowerShellJson(bad), [], JSON.stringify(bad));
  }
});
