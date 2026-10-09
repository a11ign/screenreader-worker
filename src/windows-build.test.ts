/**
 * `/health`'s `environment` carries `windowsBuild` -- `"<build>.<ubr>"` -- beside `windowsVersion`, so a
 * cumulative-update split is visible (#4433).
 *
 * WHICH HALF EACH TEST PROVES, as `health-runs-no-sync-child.test.ts` states it: `server.ts` needs guidepup and
 * therefore a screen reader, so no test here can serve a real `/health` or read a Windows registry. The PARSE
 * (`windowsBuildFrom`, pure) is run for real: its source is cut out of `server.ts` and evaluated, so the test
 * exercises the function the worker ships and not a copy. The WIRING is read off the source. That a real guest
 * answers with its real UBR is a fleet reading, and it is `orchestrator`'s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const server = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");
const bodyOf = (name: string) =>
  new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(server)?.[0] ?? "";

/** The worker's own `windowsBuildFrom`, run: the source is the one thing that cannot drift from the shipped code. */
function shippedParser(source: string): (raw: string) => string {
  assert.ok(source.length > 0, "windowsBuildFrom not found in server.ts; this scan is broken, not passing");
  return new Function(`${stripTypeScriptTypes(source)}\nreturn windowsBuildFrom;`)() as (raw: string) => string;
}
const windowsBuildFrom = shippedParser(bodyOf("windowsBuildFrom"));

test("a real reading is reported as <build>.<ubr>, trimmed of PowerShell's line ending", () => {
  assert.equal(windowsBuildFrom("26100.4652"), "26100.4652");
  assert.equal(windowsBuildFrom("26100.4652\r\n"), "26100.4652");
});

test("two guests one cumulative update apart read differently, and the same update reads the same", () => {
  assert.notEqual(windowsBuildFrom("26100.4652"), windowsBuildFrom("26100.4946"));
  assert.equal(windowsBuildFrom("26100.4652"), windowsBuildFrom(" 26100.4652 "));
});

test("an unreadable or half-read value is \"unknown\", never a guess", () => {
  // `"26100."` is what the script prints when the key has no UBR value: a half reading would drift against
  // every box that answered properly, and "unknown" is comparable and visibly not a build.
  for (const raw of ["", "   ", "unknown", "26100.", ".4652", "10.0.26100.4652", "26100.4652 extra", "error"]) {
    assert.equal(windowsBuildFrom(raw), "unknown", `${JSON.stringify(raw)} was reported as a build`);
  }
});

test("the script reads CurrentBuild and UBR from the registry's CurrentVersion key", () => {
  const script = /const WINDOWS_BUILD_SCRIPT =\s*"((?:[^"\\]|\\.)*)"/.exec(server)?.[1] ?? "";
  assert.ok(script.length > 0, "WINDOWS_BUILD_SCRIPT not found; this scan is broken, not passing");
  assert.match(script, /HKLM:\\\\SOFTWARE\\\\Microsoft\\\\Windows NT\\\\CurrentVersion/);
  assert.match(script, /\$k\.CurrentBuild/);
  assert.match(script, /\$k\.UBR/);
});

test("windowsVersion is untouched: it is a capture-cache-key input, so its script and reader keep their shape", () => {
  assert.match(server,
    /const WINDOWS_VERSION_SCRIPT =\s*"\$os = Get-CimInstance Win32_OperatingSystem; \\"\$\(\$os\.Caption\) \$\(\$os\.Version\)\\"";/,
    "windowsVersion's script changed; every cached capture's key moves with it");
  assert.doesNotMatch(bodyOf("windowsBuildFrom") + bodyOf("refreshWindowsBuild"), /windowsVersion/,
    "windowsBuild is a NEW field and must not be derived from, or written into, windowsVersion");
});

test("the build is read off /health's request path: beside windowsVersion on the sampler's tick, and memoised only when real", () => {
  const refresh = bodyOf("refreshWindowsBuild");
  assert.ok(refresh.length > 0, "refreshWindowsBuild not found; this scan is broken, not passing");
  assert.match(refresh, /await sampledValue\(/, "the read must be the asynchronous one");
  assert.doesNotMatch(refresh, /powershellValue\(|execFileSync|spawnSync/, "a synchronous read blocks the event loop");
  assert.match(refresh, /if \(windowsBuild !== "unknown"\) bootConstants\.set\(/,
    "an \"unknown\" must not be memoised, or one transient failure is permanent for the life of the worker");
  assert.match(server, /readWindowsVersion: async \(\) => \{[\s\S]*?refreshWindowsBuild\(\)/,
    "the build is not read on the version sampler's tick");
});

test("currentEnvironment serves windowsBuild on every call, after the 5 s cache", () => {
  const current = bodyOf("currentEnvironment");
  assert.ok(current.length > 0, "currentEnvironment not found; this scan is broken, not passing");
  assert.ok(current.indexOf("windowsBuild }") > current.indexOf("runtimeEnvironment()"),
    "windowsBuild must be merged AFTER the cache decision, or a reading taken after the first /health is frozen for 5 s");
  assert.doesNotMatch(bodyOf("runtimeEnvironment"), /windowsBuild/, "the 5 s cache must not hold the sampled build");
});
