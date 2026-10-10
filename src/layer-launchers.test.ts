/**
 * WHAT A WORKER RUNS REACHES OUTSIDE THE LAYER, AND THAT REACH IS DECLARED ONCE (ADR 0039 item 6d, #3397; moved here by #3741).
 *
 * The launchers reach the foreground-lock script and the capture-check harness, both of which live in the
 * guest checkout and not in this layer. Each launcher used to carry its own copy of those paths, and a move
 * that changed one left the other naming a file that was not there: `run-server.cmd` warned and started a
 * worker that returned 0 phrases from every capture. `launcher-reach.cmd` says what the launchers reach and
 * `run-capture-check.cmd` `call`s it.
 *
 * This is the half of `layer-launchers.test.ts` that reads only launchers. The half that reads the provision
 * stamp, `layers.json` and `packages/worker-fleet` stays in `a11ign/a11ign`, where those files are. The reached
 * files are not here either, so "every file the declaration names exists" cannot be asked of THIS checkout: a
 * fixture guest checkout stands in, and the positive control shows that a missing one is refused.
 *
 * `run-server.cmd` is the exception, on purpose. The stamp HASHES it, so editing it moves `provisionRevision`
 * on every worker and costs a recapture. It keeps its two literals and this file pins them equal to the
 * declaration, so a path still cannot change in one place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAYER_SRC = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => readFileSync(join(LAYER_SRC, name), "utf8");

/**
 * Where a guest places this layer, relative to its checkout root. The launchers' `cd /d "%~dp0..\..\.."`
 * climbs exactly this depth, so a layer placed elsewhere changes where they run from.
 */
const GUEST_LAYER_PATH = "packages/nvda-worker";

/** What each launcher declaration NAMES: the foreground-lock script and the capture harness. */
const REACHED = ["FLT", "CAPTURE_CHECK"] as const;

/** One `set "NAME=value"` line of a launcher declaration, forward-slashed; `undefined` when it does not say. */
function declaredReach(declaration: string, name: string): string | undefined {
  const line = declaration.split(/\r?\n/).map((l) => new RegExp(`^set "${name}=(.+)"\\s*$`).exec(l)).find(Boolean);
  return line?.[1].replaceAll("\\", "/");
}

/** The declared reach that is NOT there under `root`: the question a launcher asks before it runs. */
function absentReach(root: string): string[] {
  const reachFile = join(root, GUEST_LAYER_PATH, "src/launcher-reach.cmd");
  if (!existsSync(reachFile)) return [`${GUEST_LAYER_PATH}/src/launcher-reach.cmd is absent`];
  const declaration = readFileSync(reachFile, "utf8");
  return REACHED.flatMap((name) => {
    const path = declaredReach(declaration, name);
    if (path === undefined) return [`${name} is not declared`];
    return existsSync(join(root, path)) ? [] : [`${name} -> ${path} is absent`];
  });
}

/** Writes `rel` under `root`, creating its directory. */
function put(root: string, rel: string, content: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/**
 * A guest checkout holding this layer's declaration (when `withDeclaration`), and an empty stand-in for each
 * of the reached files `present` lists. The declaration is this layer's real one, not a restated copy.
 */
function fixtureCheckout(present: readonly (typeof REACHED)[number][], withDeclaration = true): string {
  const root = mkdtempSync(join(tmpdir(), "layer-launchers-"));
  const declaration = read("launcher-reach.cmd");
  if (withDeclaration) put(root, `${GUEST_LAYER_PATH}/src/launcher-reach.cmd`, declaration);
  for (const name of present) put(root, declaredReach(declaration, name) as string, "");
  return root;
}

/** Code lines only: a path named in a `rem` comment is not a path that is read. */
const codeLines = (source: string) => source.split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l));

test("the declaration names the reach, and the root it climbs to", () => {
  const declaration = read("launcher-reach.cmd");
  for (const name of REACHED) assert.ok(declaredReach(declaration, name), `${name} is not declared`);
  assert.equal(declaredReach(declaration, "CHECKOUT_ROOT"), "%~dp0../../..",
    "the checkout root is no longer three levels above the declaration, so the launchers' directory change is wrong");
});

test("POSITIVE CONTROL: a checkout with the foreground-lock script absent is REFUSED, naming it", () => {
  const complete = fixtureCheckout(["FLT", "CAPTURE_CHECK"]);
  const noFlt = fixtureCheckout(["CAPTURE_CHECK"]);
  const noHarness = fixtureCheckout(["FLT"]);
  const noDeclaration = fixtureCheckout(["FLT", "CAPTURE_CHECK"], false);
  try {
    assert.deepEqual(absentReach(complete), [], "the control's green state is unreachable: a complete fixture was refused");
    assert.deepEqual(absentReach(noFlt), [
      "FLT -> packages/worker-fleet/src/provisioning/apply-foreground-lock-timeout.ps1 is absent",
    ]);
    assert.deepEqual(absentReach(noHarness), [
      "CAPTURE_CHECK -> packages/lab/src/harnesses/capture-check.ts is absent",
    ]);
    assert.deepEqual(absentReach(noDeclaration), ["packages/nvda-worker/src/launcher-reach.cmd is absent"]);
  } finally {
    for (const root of [complete, noFlt, noHarness, noDeclaration]) rmSync(root, { recursive: true, force: true });
  }
});

test("run-capture-check.cmd reads the declaration and STOPS on an absent file, never warns and continues", () => {
  const launcher = read("run-capture-check.cmd");
  const code = codeLines(launcher);
  assert.ok(code.some((l) => /^call "%~dp0launcher-reach\.cmd" \|\| exit \/b 1$/.test(l.trim())),
    "the launcher does not `call` the declaration and stop when it is missing");
  assert.ok(code.some((l) => /^cd \/d "%CHECKOUT_ROOT%" \|\| exit \/b 1$/.test(l.trim())),
    "the launcher does not change into the declared root");
  assert.deepEqual(code.filter((l) => /packages[\\/]/.test(l)), [],
    "the launcher names a repo path in code again, a second copy of what the declaration says");
  for (const name of REACHED) {
    const start = code.findIndex((l) => l.includes(`if not exist "%${name}%"`) && l.trim().endsWith("("));
    assert.notEqual(start, -1, `no existence check for %${name}%`);
    const block = code.slice(start, code.indexOf(")", start)).join("\n");
    assert.match(block, /exit \/b 1/, `an absent %${name}% does not stop the check`);
    assert.doesNotMatch(block, /WARNING/, `an absent %${name}% only warns`);
  }
  assert.match(launcher, /"%CAPTURE_CHECK%" > capture-check\.log/, "the harness is no longer run from the declared path");
});

test("run-server.cmd keeps its two literals, and they EQUAL the declaration", () => {
  // Not a reader: the stamp hashes this file (see the header). The pin is what stops the copy drifting.
  const server = codeLines(read("run-server.cmd")).join("\n");
  const declaration = read("launcher-reach.cmd");
  const flt = /set "FLT=([^"]+)"/.exec(server)?.[1].replaceAll("\\\\", "\\");
  assert.equal(flt?.replaceAll("\\", "/"), declaredReach(declaration, "FLT"),
    "run-server.cmd names a different foreground-lock script than the declaration");
  const depth = /cd \/d "(%~dp0[^"]+)"/.exec(server)?.[1];
  assert.equal(depth?.replaceAll("\\", "/"), declaredReach(declaration, "CHECKOUT_ROOT"),
    "run-server.cmd changes directory to a different root than the declaration");
});

/**
 * A LAUNCHER'S EXIT CODE MUST REACH ITS LOG (#3397, found on a real worker).
 *
 * In cmd a digit directly before `>>` is a HANDLE number, so `echo EXITCODE=0>> log` redirects handle 0 and
 * writes NOTHING to the file, and `echo EXITCODE=1>> log` writes `EXITCODE=` without its digit. Measured on
 * a11y-worker-4 with `cmd /c`; the launcher's header called the line "recorded the same way a verdict is" and
 * the first real run of `run-capture-check.cmd` had no such line. The redirect goes FIRST, where no digit can
 * touch it. Lines that record an exit code are found by the word, not by the old shape, so a new launcher that
 * copies the broken one is refused here too.
 */
const REDIRECT_FIRST = /^\s*>> \S+ echo EXITCODE[= ]/;
const EXITCODE_LINE = /EXITCODE/;

function exitCodeLinesRefused(source: string): string[] {
  return source.split("\n").filter((line) => EXITCODE_LINE.test(line) && !REDIRECT_FIRST.test(line));
}

test("every launcher line that records an exit code redirects FIRST, so no digit can be read as a handle", () => {
  const launchers = readdirSync(LAYER_SRC).filter((f) => f.endsWith(".cmd"));
  const lines = launchers.flatMap((f) => read(f).split("\n").filter((l) => EXITCODE_LINE.test(l)));
  // The population is the run-capture-check.cmd lines (two early exits and the verdict) plus run-capture.cmd's;
  // the positive control below shows the filter refuses the shape, so this count is what keeps it from being vacuous.
  assert.ok(lines.length >= 4, `expected the launchers' EXITCODE lines, found ${lines.length}`);
  for (const f of launchers) assert.deepEqual(exitCodeLinesRefused(read(f)), [], `${f} records an exit code the log never receives`);
});

test("positive control: the shapes that lost the digit are the ones refused", () => {
  assert.deepEqual(exitCodeLinesRefused("echo EXITCODE=0>> capture-check.log"), ["echo EXITCODE=0>> capture-check.log"]);
  assert.deepEqual(exitCodeLinesRefused("  echo EXITCODE=1>> capture-check.log"), ["  echo EXITCODE=1>> capture-check.log"]);
  assert.deepEqual(exitCodeLinesRefused("echo EXITCODE %ERRORLEVEL%>> capture.log"), ["echo EXITCODE %ERRORLEVEL%>> capture.log"]);
  assert.deepEqual(exitCodeLinesRefused(">> capture-check.log echo EXITCODE=%ERRORLEVEL%"), []);
  assert.deepEqual(exitCodeLinesRefused("  >> capture-check.log echo EXITCODE=1"), []);
});
