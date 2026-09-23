/**
 * #1513 (the RECORD half): every capture's `environment` carries the CSS viewport the page was actually read
 * at -- `innerWidth`, `innerHeight`, `devicePixelRatio` -- measured IN THE PAGE, not assumed from launch flags.
 *
 * Why it matters: captures ran `--start-maximized` with no window size, so the width was each worker's display.
 * caselaw's two captures matched <768px and >=992px layouts and yielded different findings (#1043), and the Met
 * Office page hides its h1 below 1280px (#1522). Nothing recorded which width produced which evidence.
 *
 * Imports only `capture-pure.mjs`: `capture-core.mjs` imports `@guidepup/guidepup`, which throws at import where no
 * screen reader exists, so the decision lives in the pure module and the wiring is pinned by source text below.
 *
 * NOT a key, and STILL not one after #1561 pinned the window: what that row keys is `windowSize`, the width the
 * worker ASKS Edge for, which a cache lookup can know before the capture exists. These three fields are the
 * OUTCOME of that request -- Edge clamps it to the display work area -- and they are what CONFIRMS the pin on a
 * real capture rather than what identifies it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "@a11ign/evidence/source-text";
import { viewportFromMarks } from "./capture-pure.mjs";

const mark = (fields: Record<string, unknown>): Record<string, unknown> =>
  ({ event: "viewport", atMs: 1200, targetMatch: "matched", ...fields });
const READ_AT_1024 = { innerWidth: 1024, innerHeight: 649, devicePixelRatio: 1 };

test("#1513: a viewport read becomes exactly the three environment fields, and nothing else of the mark", () => {
  const diagnostics = [{ event: "pageSettled", atMs: 1100 }, mark(READ_AT_1024), { event: "sweep", atMs: 9000 }];
  assert.deepEqual(viewportFromMarks(diagnostics), READ_AT_1024);
});

test("#1513: no viewport mark means NO fields -- absent reads as not measured, never as a zero width", () => {
  assert.deepEqual(viewportFromMarks([{ event: "pageSettled", atMs: 1100 }]), {});
  assert.deepEqual(viewportFromMarks([]), {});
  assert.deepEqual(viewportFromMarks(undefined as never), {}, "a result with no diagnostics at all");
});

test("#1513: a RETRIED capture records the retry's read -- the last viewport mark wins", () => {
  // `runCapture` hands ONE marks array to `captureWithLocalRecovery` as `diagnosticsSink`, and a recoverable fault
  // re-runs `captureWithNvda` with the same options -- so the returned diagnostics hold BOTH attempts' marks.
  const diagnostics = [mark({ innerWidth: 640, innerHeight: 377, devicePixelRatio: 1 }), { event: "recovered" },
    mark(READ_AT_1024)];
  assert.deepEqual(viewportFromMarks(diagnostics), READ_AT_1024);
});

test("#1513: a read that failed records nothing, including when it was the retry's", () => {
  const failed = mark({ innerWidth: null, innerHeight: null, devicePixelRatio: null });
  assert.deepEqual(viewportFromMarks([failed]), {});
  assert.deepEqual(viewportFromMarks([mark(READ_AT_1024), failed]), {},
    "the attempt that produced the result could not read, so an earlier attempt's width is not its width");
  for (const bad of [{ innerWidth: 0 }, { innerWidth: Number.NaN }, { innerWidth: "1024" }]) {
    assert.deepEqual(viewportFromMarks([mark({ ...READ_AT_1024, ...bad })]), {}, JSON.stringify(bad));
  }
});

test("#1513: the fields are a fresh object, so merging them cannot write back into the capture's marks", () => {
  const source = mark(READ_AT_1024);
  const fields = viewportFromMarks([source]) as Record<string, number>;
  fields.innerWidth = 1;
  assert.equal(source.innerWidth, READ_AT_1024.innerWidth);
});

/**
 * THE WIRING, by source text -- the one place this can be pinned without a screen reader.
 *
 * Each anchor is found before any order is compared (the positive control), because `indexOf` answering -1 for
 * both sides would make "before" true of text that is not there.
 */
const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
function positions(text: string, anchors: string[]): number[] {
  const at = anchors.map((anchor) => text.indexOf(anchor));
  anchors.forEach((anchor, i) => assert.notEqual(at[i], -1, `anchor not found: ${anchor}`));
  return at;
}

test("#1513: capture-core reads the viewport after the page settles and BEFORE any probe, and marks it", () => {
  const core = source("capture-core.mjs");
  const [settled, read, marked, phases] = positions(core,
    ["await waitForPageToSettle(diag);", "await viewportMeasure()", 'diag.mark("viewport"', "await runCapturePhases("]);
  assert.ok(settled < read && read < marked && marked < phases, "settle -> read -> mark -> probes, in that order");
});

const PAGE_WIDTH_TOKEN = /innerWidth|viewport/;

/** `runtimeEnvironment`'s body, sliced out of `text` by the two function markers around it. */
function runtimeEnvironmentBody(text: string): string {
  const [start, end] = positions(text, ["function runtimeEnvironment() {", "function provisionRevision() {"]);
  return text.slice(start, end);
}

/**
 * THE RULE, as a function of source TEXT rather than of a file, so the two controls below can hand it
 * fixtures instead of the live `server.mjs` (#2145): a control anchored to a real file stops being a
 * control the day somebody edits that file.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING, and that is the whole of #2145. What must not enter the cached
 * object is a page's width; a comment SAYING so is prose, and the raw-text match this replaced charged it
 * as code — so the guard's only advice to an author writing down its own rationale was to delete it.
 * Measured on a comment-only edit that added no code: 7 passed / 1 failed, 8 / 0 with the comment removed.
 *
 * `stripComments` from `@a11ign/evidence` rather than a regex written here, because it is the stripper
 * this repository already owns and tests — and because #2131's work on it then reaches this guard for free.
 * A stripper that desynchronises cannot make this guard silently pass: `positions` asserts both markers are
 * still found, so damage to the slice reads as a missing anchor rather than as an empty body.
 */
function assertNoPageWidthInRuntimeEnvironment(text: string): void {
  assert.doesNotMatch(runtimeEnvironmentBody(stripComments(text)), PAGE_WIDTH_TOKEN,
    "the cached object is also /health's answer, and a page's width is not the worker's");
}

/** A minimal `server.mjs` carrying both markers, so a fixture body can be read by the real slicer. */
const serverFixture = (body: string): string => [
  "function runtimeEnvironment() {",
  "  return {",
  body,
  "  };",
  "}",
  "",
  "function provisionRevision() {",
].join("\n");

test("#1513: server merges the read into THAT capture's environment, never into the cached runtime environment", () => {
  const server = source("server.mjs");
  positions(server, ["environment: { ...environment, ...viewportFromMarks(result.diagnostics) }"]);
  // The stripper ran on the LIVE slice and did not eat it: shorter than the raw slice means comments went,
  // and the returned object still being there means code did not. Without this pair the assertion below
  // could pass having examined an empty string.
  assert.ok(runtimeEnvironmentBody(stripComments(server)).length < runtimeEnvironmentBody(server).length,
    "comments were stripped from the live slice");
  assert.match(runtimeEnvironmentBody(stripComments(server)), /return \{/, "the stripped slice is still the body");
  assertNoPageWidthInRuntimeEnvironment(server);
});

test("#2145 POSITIVE CONTROL: the guard still REFUSES a body that reads the page's width as code", () => {
  // Without this, stripping the body away entirely would satisfy the assertion above having examined
  // nothing — the emptiness trap `.claude/rules/agent-practices.md` requires a named control for. This is
  // that control, and it is deliberately the same token the live guard forbids.
  for (const body of ["    innerWidth: readViewport().innerWidth,", '    viewport: page.evaluate("innerWidth"),']) {
    assert.throws(() => assertNoPageWidthInRuntimeEnvironment(serverFixture(body)), assert.AssertionError, body);
  }
});

test("#2145 NEGATIVE CONTROL: a comment NAMING the token is prose, and the guard accepts it", () => {
  // The defect, stated as a test. Both comment forms, because the stripper handles them separately.
  const line = "    // NOT innerWidth: that is the page's width, read in the page, and it cannot be known here.";
  const block = "    /* The viewport belongs to the capture, not to this cached object. */";
  for (const comment of [line, block]) {
    assertNoPageWidthInRuntimeEnvironment(serverFixture(`${comment}\n    windowSize: CAPTURE_WINDOW_SIZE,`));
  }
});

test("#1513: browser-session exports the page read, and the PAGE evaluates all three values", () => {
  const session = source("browser-session.mjs");
  // The expression the page runs, not the names in the return object: a read that dropped one value from the
  // expression would still MENTION it below, and report null for it on every capture.
  const [exported, evaluated] = positions(session,
    ["export async function viewportMeasure()", 'evaluateOnPageTarget("({ innerWidth, innerHeight, devicePixelRatio })")']);
  assert.ok(exported < evaluated, "the evaluation belongs to viewportMeasure");
});
