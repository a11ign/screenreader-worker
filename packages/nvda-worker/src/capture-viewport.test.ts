/**
 * #1513 (the RECORD half): every capture's `environment` carries the CSS viewport the page was actually read
 * at -- `innerWidth`, `innerHeight`, `devicePixelRatio` -- measured IN THE PAGE, not assumed from launch flags.
 *
 * Why it matters: captures run `--start-maximized` with no window size, so the width is each worker's display.
 * caselaw's two captures matched <768px and >=992px layouts and yielded different findings (#1043), and the Met
 * Office page hides its h1 below 1280px (#1522). Nothing recorded which width produced which evidence.
 *
 * Imports only `capture-pure.mjs`: `capture-core.mjs` imports `@guidepup/guidepup`, which throws at import where no
 * screen reader exists, so the decision lives in the pure module and the wiring is pinned by source text below.
 *
 * NOT a key: the width joins neither `environmentKey` nor `MUST_MATCH` here (product-manager's ruling, 09:33Z,
 * under ceo's ruling (b)); pinning the window, and keying on it, is #1561.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("#1513: server merges the read into THAT capture's environment, never into the cached runtime environment", () => {
  const server = source("server.mjs");
  positions(server, ["environment: { ...environment, ...viewportFromMarks(result.diagnostics) }"]);
  const [start, end] = positions(server, ["function runtimeEnvironment() {", "function provisionRevision() {"]);
  assert.doesNotMatch(server.slice(start, end), /innerWidth|viewport/,
    "the cached object is also /health's answer, and a page's width is not the worker's");
});

test("#1513: browser-session exports the page read, and the PAGE evaluates all three values", () => {
  const session = source("browser-session.mjs");
  // The expression the page runs, not the names in the return object: a read that dropped one value from the
  // expression would still MENTION it below, and report null for it on every capture.
  const [exported, evaluated] = positions(session,
    ["export async function viewportMeasure()", 'evaluateOnPageTarget("({ innerWidth, innerHeight, devicePixelRatio })")']);
  assert.ok(exported < evaluated, "the evaluation belongs to viewportMeasure");
});
