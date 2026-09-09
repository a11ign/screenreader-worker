/**
 * THE TAB WALK'S VERDICT IS ABOUT A DOCUMENT NOBODY RECORDED — #863.
 *
 * The row asked which of two readings is right: `cycled` at 14 stops, or `truncated` at 90, on
 * `calendly.com/` ten minutes apart on the same worker build. **Neither is wrong, and they are not about
 * the same page.**
 *
 *     capture    stops  verdict     the document the walk actually ran on
 *     12-49-29     14   cycled      accounts.google.com/v3/signin/identifier
 *     12-59-26     90   truncated   calendly.com/scheduling
 *
 * Across the eight calendly captures on disk the split is **4/4 with no exception**: every `cycled` walk
 * ran on Google's sign-in page, every `truncated` walk ran on a calendly URL. `probeConfiguredForm`
 * activates "Continue with Google" and the focus probe runs afterwards — the #685/#691 mechanism, one
 * probe further on than the census fix (#699) reached.
 *
 * **The census cannot contradict it and is not wrong to fail to.** It reads at t≈0 and correctly reports
 * `targetMatch: matched` for calendly; the walk happens ~300 s later somewhere else. Every mark is
 * truthful about its own moment, and the capture as a whole reads as one page. A capture is not an
 * instant.
 *
 * ## WHAT THE ROW EXPECTED, AND WHAT THE CORPUS SAYS
 *
 * The row's hypothesis was that `focusOrderCycled` compares PHRASES — the ambiguity `sweepInDirection`
 * refuses in its own comment — so `cycled` at 14 might be a FALSE COMPLETION, 2.4.3's evidence resting on
 * a walk of 14 of 90 stops.
 *
 * **Measured on all 16 `cycled` verdicts in the corpus: every one is a genuine ring return.** The first
 * three phrases appear at exactly two indices, 0 and `length - 3`, on 16 of 16 — never in the middle. The
 * ambiguity is real and the corpus contains no instance of it firing. That is worth stating precisely
 * rather than fixing on suspicion: a remedy for a defect nobody has measured is a change with no test
 * that can fail.
 *
 * ## AND A SEPARATE FINDING THE SAME TABLE FORCED
 *
 * IKEA returns `stops: 0` on every capture, with `cycled`, `stalled` and `truncated` all false — three
 * booleans over four loop exits, so "the first Tab announced nothing" and "this page has no tab stops"
 * arrive identically. The same capture's `focusConfinement` mark says `controlsOnPage: 265`.
 *
 * `sweepOutcomes` pushed NOTHING for those, so 2.1.2 and 2.4.3 read a clean channel from a probe that
 * never read one — the absence of a measurement arriving as the measurement zero, #677's rule one probe
 * over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { focusOrderCycled, focusWalkTruncated } from "./capture-pure.mjs";

const fixture = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "fixtures-focus-863.json"), "utf8")) as {
    captures: {
      source: string, requestedUrl: string,
      focusOrder: { stops: number, cycled: boolean, stalled: boolean, truncated: boolean },
      pageStateBeforeFocus: { beforeProbe: string, targetUrl: string } | null,
      focusConfinement: { ring: number, controlsOnPage: number, confined: boolean } | null,
      stops: string[],
    }[],
  };

const byStops = (n: number) => {
  const found = fixture.captures.find((c) => c.focusOrder.stops === n);
  assert.ok(found, `the fixture no longer holds the ${n}-stop capture this test is about`);
  return found!;
};

test("the 14-stop `cycled` and the 90-stop `truncated` walked DIFFERENT documents", () => {
  const cycled = byStops(14);
  const truncated = byStops(90);

  // Both were asked for calendly. That is the row's "same URL", and it is true of the REQUEST.
  assert.equal(cycled.requestedUrl, "https://calendly.com/");
  assert.equal(truncated.requestedUrl, "https://calendly.com/");

  // And the fingerprint taken immediately before each walk says otherwise.
  assert.match(cycled.pageStateBeforeFocus!.targetUrl, /^https:\/\/accounts\.google\.com\//,
    "the 14-stop walk ran on Google's sign-in page, reached by the form probe activating "
    + "'Continue with Google'");
  assert.match(truncated.pageStateBeforeFocus!.targetUrl, /^https:\/\/calendly\.com\//);
  assert.notEqual(new URL(cycled.pageStateBeforeFocus!.targetUrl).origin,
    new URL(truncated.pageStateBeforeFocus!.targetUrl).origin,
    "different ORIGINS — this is not two readings of one page disagreeing");
});

test("the 14-stop cycle is a GENUINE ring return, not phrase equality being fooled", () => {
  // The row's hypothesis, tested rather than assumed. A false completion would show the opening three
  // phrases recurring in the MIDDLE of the walk; a real ring return shows them exactly twice.
  const { stops } = byStops(14);
  const head = stops.slice(0, 3).join("|");
  const at = stops.map((_, i) => i).filter((i) => stops.slice(i, i + 3).join("|") === head);
  assert.deepEqual(at, [0, 11],
    "the opening three phrases appear only at the start and at the end, so the walk really did return "
    + "to where it began — on a 14-stop ring, which is what Google's sign-in page has");
  assert.equal(focusOrderCycled(stops), true);
});

test("the 90-stop walk never returns, so `cycled` and `truncated` are both honest", () => {
  const { stops } = byStops(90);
  const head = stops.slice(0, 3).join("|");
  const at = stops.map((_, i) => i).filter((i) => stops.slice(i, i + 3).join("|") === head);
  assert.deepEqual(at, [0], "the opening never recurs — calendly's ring is longer than the walk");
  assert.equal(focusOrderCycled(stops), false);
});

test("a walk that read NOTHING is distinguishable from a page with no tab stops", () => {
  const silent = byStops(0);
  // Today's record: three booleans, all false, and 265 controls on the page.
  assert.deepEqual(
    [silent.focusOrder.cycled, silent.focusOrder.stalled, silent.focusOrder.truncated],
    [false, false, false]);
  assert.equal(silent.focusConfinement!.controlsOnPage, 265,
    "a ring of 0 on a page with 265 controls is a non-answer, and nothing on the mark said so");
  // `stop` is what says so. The fixture predates it, which is exactly why the consumer gates on presence.
  assert.equal("stop" in silent.focusOrder, false,
    "this fixture is pre-#863 evidence — the guard below must not invent a reason it cannot know");
});

test("`truncated` keeps its exact meaning, derived from the stop reason", () => {
  // `sweepOutcomes` turns `truncated` into the `cantTell` that stops 2.1.2 claiming an unearned pass, so
  // this refactor must not move it by even one combination. Both formulas, over every input.
  for (const stop of ["cycled", "stalled", "silent", "deadline", "cap"] as const) {
    for (const n of [0, 1, 14, 90]) {
      const cycled = stop === "cycled";
      const repeatsHitTrap = stop === "stalled";
      const before = !cycled && !repeatsHitTrap && n > 0;   // the expression #863 replaced, verbatim
      assert.equal(focusWalkTruncated(stop, n), before,
        `truncated disagrees for stop=${stop} stops=${n} — the derivation changed behaviour`);
    }
  }
});

test("the ONLY thing separating the two calendly readings is the document", () => {
  // The floor: if a future capture set breaks the 4/4 correlation, this fixture's own claim is stale and
  // the finding needs re-deriving rather than quoting. Both walks are `probeFocus` walks on one build.
  const cycled = byStops(14);
  const truncated = byStops(90);
  assert.equal(cycled.focusOrder.cycled, true);
  assert.equal(truncated.focusOrder.truncated, true);
  assert.notEqual(cycled.stops[0], truncated.stops[0],
    "the two walks do not even start at the same control, which is the cheapest visible sign that they "
    + "are not two measurements of one page");
});

/** THE WIRING, read from source — this package throws at import where no screen reader exists. */
const PROBES = readFileSync(
  resolve(import.meta.dirname, "capture-probes.mjs"), "utf8");

const probeFocusOrderBody = () => {
  const at = PROBES.indexOf("async function probeFocusOrder({");
  assert.notEqual(at, -1, "probeFocusOrder is gone or renamed — this guard's subject, not a pass");
  const from = PROBES.slice(at);
  return from.slice(0, from.indexOf("\n}\n"));
};

test("the document is read BEFORE the walk, not after it", () => {
  // After the walk is the defect in miniature: `probeRouteChange` can navigate, and a URL read at the end
  // would name wherever the capture finished rather than what these stops describe. Same ordering
  // argument as `censusBeforeNavigating`, one probe along.
  const body = probeFocusOrderBody();
  const read = body.indexOf("currentPageUrl()");
  const firstTab = body.indexOf('nvda.press("Tab")');
  assert.ok(read >= 0, "probeFocusOrder must record which document it is about to walk");
  assert.ok(read < firstTab, "the document must be read before the first Tab, or it names the wrong page");
});

test("every loop exit names itself, so no two endings share a record", () => {
  const body = probeFocusOrderBody();
  for (const [exit, marker] of [
    ["deadline", 'stop = "deadline"'], ["silent", 'stop = "silent"'],
    ["stalled", 'stop = "stalled"'], ["cycled", 'stop = "cycled"'],
  ] as const) {
    assert.ok(body.includes(marker), `the ${exit} exit does not record its reason`);
  }
  // `cap` is the fall-out-of-the-loop ending, so it is the initial value rather than a break.
  assert.match(body, /let stop = [^\n]*\("cap"\)/,
    "`cap` must be the initial value — an ending reached by NOT breaking cannot assign itself");
  assert.match(body, /stop,\n\s*walkedUrl,/, "both must reach the mark");
});
