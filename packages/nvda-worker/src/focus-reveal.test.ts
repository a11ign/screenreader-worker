
/**
 * 1.4.13 Content on Hover or Focus — the DISMISSABLE bullet, decided from three censuses and two focus
 * reads. The criterion was recorded `out-of-scope` until 2026-09-05 on the reasoning "the screen-reader
 * path never hovers", which is true of the hover trigger and settles neither of the other two bullets:
 * it covers "pointer hover OR KEYBOARD FOCUS", and we drive keyboard focus.
 */
import { test as focusRevealTest } from "node:test";
import focusRevealAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { focusRevealVerdict, censusGrowth, focusResetOutcome, namesThatAppeared } from "./capture-pure.mjs";

const BASE = { formControl: 2, link: 3, graphic: 0, heading: 1, landmark: 1 };
const GREW = { ...BASE, link: 4 };

focusRevealTest("a census that failed with an ERROR OBJECT also reads UNKNOWN", () => {
  // THE SHAPE THE FIRST VERSION OF THIS FUNCTION MISSED, and `tsc` caught it rather than a capture run.
  // `structuralCensus` does not return `null` on failure — it returns `{ error }`. So the obvious
  // `if (!before)` guard passed the failure straight through, every count read 0, and a dropped CDP socket
  // became "nothing appeared on focus", which is a conformant page. Absence read as a value, in the one
  // place where absence IS the question.
  const v = focusRevealVerdict({
    before: { error: "no socket" }, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a",
  });
  focusRevealAssert.equal(v.revealed, null, "an errored census is not a reading of zero");
});

focusRevealTest("a failed census reads UNKNOWN, never 'nothing appeared'", () => {
  // The rule this file has paid for more than once: absence read as a value. `structuralCensus` returns
  // null when the CDP socket did not answer, and treating that as zero would turn every dropped connection
  // into a conformant page.
  const v = focusRevealVerdict({ before: null, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, null, "a census that did not answer is not a reading of zero");
  focusRevealAssert.match(String(v.why), /census unavailable/);
});

focusRevealTest("content that appears on focus and survives Escape is the Dismissable failure", () => {
  const v = focusRevealVerdict({ before: BASE, onFocus: GREW, afterEscape: GREW, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, true);
  focusRevealAssert.equal(v.dismissed, false, "Escape did not remove it");
  focusRevealAssert.equal(v.focusHeld, true, "and focus never moved, so Escape is the mechanism being tested");
});

focusRevealTest("content dismissed by Escape while focus HELD is the conformant shape", () => {
  const v = focusRevealVerdict({ before: BASE, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.dismissed, true);
  focusRevealAssert.equal(v.focusHeld, true);
});

focusRevealTest("Escape that MOVED focus dismissed nothing — it navigated", () => {
  // The criterion asks for a mechanism to dismiss "WITHOUT MOVING pointer hover or keyboard focus". A page
  // where Escape moves focus has not demonstrated that mechanism, and reporting `dismissed: true` alone
  // would credit it with one. `focusHeld` is reported separately so a rule can tell the two apart.
  const v = focusRevealVerdict({ before: BASE, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "b" });
  focusRevealAssert.equal(v.focusHeld, false);
  focusRevealAssert.equal(v.vanished, true, "content went while the trigger no longer holds focus");
});

focusRevealTest("nothing appearing on focus is not a finding of any kind", () => {
  const v = focusRevealVerdict({ before: BASE, onFocus: BASE, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, false);
  focusRevealAssert.equal(v.dismissed, undefined, "there is nothing to dismiss, so the bullet does not apply");
});

/**
 * THE BUG THIS FILE'S SIX TESTS ABOVE COULD NOT SEE, AND WHY IT NEEDED A DIFFERENT KIND OF TEST.
 *
 * All 18 of the 1.4.13 cases came back BLIND from their first capture — 15 corpus plus 3 held-out — while
 * every unit test here passed. They were right to: `focusRevealVerdict` was never wrong. What was wrong is
 * WHERE its evidence came from. `probeFocusReveal` ran after `probeFocusOrder`, which walks the entire tab
 * ring, so the panel the probe exists to catch was already open when it took its "before" census and the
 * delta was zero by construction. Measured on `focus-panel-undismissable-fee.bad`: stop 2 is the trigger,
 * stop 3 is the link inside the `hidden` panel.
 *
 * A verdict function tested on hand-built censuses cannot fail on that, however many cases you give it —
 * which is this repo's own rule that a metric computed on data sharing the flaw cannot see the flaw. The
 * property that was actually broken is an ORDER, so it is the order that has to be asserted.
 *
 * Source text, deliberately and with the anti-vacuity guard that requires: `probePasses` needs real NVDA,
 * so there is nothing to import and call. `forbidden-input-keys-parity.test.ts` documents the same
 * exception for the same reason.
 */
focusRevealTest("the reveal probe is sequenced BEFORE the probe that walks the tab ring", () => {
  // `probePasses`, where both live, moved to `capture-probes.mjs` in the 2026-09-05 split.
  const source = readFileSync(
    resolve(import.meta.dirname, "./capture-probes.mjs"), "utf8");
  const reveal = source.indexOf("results.focusReveal = probeFocusReveal_");
  // Marker updated when `probeFocusOrder`'s call site moved into `probeFocusOrderWithEventLog` (the F55
  // focus-event log, which brackets the tab walk) -- that function IS the probe that walks the tab ring
  // now, `probeFocusOrder` itself being one call inside it. Whatever the marker, the invariant is the one
  // this test's own name states; the marker is just how a source-text test has to find it.
  const order = source.indexOf("await probeFocusOrderWithEventLog");
  focusRevealAssert.ok(reveal >= 0 && order >= 0,
    "one of the two assignments is gone from capture-probes.mjs -- this test examines nothing; find where "
    + "the probes are sequenced now and assert the order there");
  focusRevealAssert.ok(reveal < order,
    "probeFocusReveal must run BEFORE probeFocusOrder. It ran after once, and its baseline census was "
    + "then taken on a page whose whole tab ring had already been focused -- so anything revealed on "
    + "focus was already in the baseline and all 18 of its cases read `revealed: false`.");
});

focusRevealTest("censusGrowth keeps 'we could not look' apart from 'there was nothing'", () => {
  focusRevealAssert.equal(censusGrowth({ error: "no socket" }, GREW), null,
    "an errored census must not read as zero growth");
  focusRevealAssert.equal(censusGrowth(BASE, { error: "no socket" }), null,
    "and it must not, in either position");
  focusRevealAssert.deepEqual(censusGrowth(BASE, BASE), [],
    "an unchanged census is EMPTY growth, which is a real reading and not an absent one");
  focusRevealAssert.deepEqual(censusGrowth(BASE, GREW), [["link", 1]],
    "growth names the role and the size, because the evidence has to say what appeared");
});

focusRevealTest("a role that SHRANK is not growth", () => {
  // Directional on purpose. Content going away while a control takes focus is 1.4.13's PERSISTENT bullet,
  // which `focusRevealVerdict` reports as `vanished` and deliberately does not judge -- folding it in here
  // would make one verdict answer two bullets, which is how a criterion gets reported more confidently
  // than its evidence allows.
  focusRevealAssert.deepEqual(censusGrowth(GREW, BASE), []);
});

/**
 * `focusResetOutcome` -- architecture-audit.md §43. `resetFocusToDocumentStart` (browser-session.mjs)
 * blurs whatever a PREVIOUS probe left focused, so `walkToReveal`'s first Tab starts at the first
 * tabbable element rather than wherever an earlier probe happened to land. This is the PURE half: given
 * that CDP call's return value, what actually happened, in words a mark can carry.
 *
 * THREE OUTCOMES, not two, and the third is the one worth a dedicated test: `blurred: null` (the reset
 * script never ran) must not read the same as `blurred: false` (it ran and confirmed nothing needed
 * clearing) -- collapsing them is the exact "absence read as a value" defect this file exists to keep out
 * of 1.4.13's own evidence, applied one call earlier.
 */
focusRevealTest("a control that held focus and was blurred reads applied:true", () => {
  const r = focusResetOutcome({ blurred: true, targetMatch: "matched", candidates: 1 });
  focusRevealAssert.equal(r.applied, true);
  focusRevealAssert.match(r.why, /held focus.*blurred/);
});

focusRevealTest("confirmed nothing held focus reads applied:true, with a DIFFERENT reason", () => {
  const r = focusResetOutcome({ blurred: false, targetMatch: "matched", candidates: 1 });
  focusRevealAssert.equal(r.applied, true);
  focusRevealAssert.match(r.why, /confirmed nothing held focus/);
  focusRevealAssert.doesNotMatch(r.why, /held focus.*blurred/,
    "true and false must not share a reason string, or a mark reader cannot tell which happened");
});

focusRevealTest("the reset script never running reads applied:false, and is NOT the same as blurred:false", () => {
  const r = focusResetOutcome({ blurred: null, targetMatch: "matched", candidates: 1 });
  focusRevealAssert.equal(r.applied, false);
  focusRevealAssert.match(r.why, /did not run/);
});

focusRevealTest("blurred:undefined (a shape the CDP call never actually returns) is treated the same as null", () => {
  const r = focusResetOutcome({ blurred: undefined, targetMatch: "matched", candidates: 1 });
  focusRevealAssert.equal(r.applied, false);
  focusRevealAssert.match(r.why, /did not run/);
});

focusRevealTest("a suspect target overrides blurred:true -- an unconfirmed document cannot vouch for its own reset", () => {
  // `focusTargetIsSuspect` is the SAME predicate `1.4.13`'s own census check reuses
  // (focus-target-suspect-parity.test.ts) -- so a reset evaluated against the wrong page must be
  // distrusted the same way a census would be, even when the script itself claims success.
  const r = focusResetOutcome({ blurred: true, targetMatch: "fallback", candidates: 3 });
  focusRevealAssert.equal(r.applied, false);
  focusRevealAssert.match(r.why, /unconfirmed document target/);
});

/**
 * `logSuppressed` -- known-gaps.md §42 interaction, found by worker-judge. §42 moved the focus-event
 * listener install to before this probe ever runs and deleted `focusLossEvidence`'s `i === 0` exception
 * (rules.ts), on the reasoning that a real listener now watches from the start. That reasoning is right
 * about the PAGE and wrong about THIS blur: `resetFocusToDocumentStart`'s `el.blur()` is capture-side
 * bookkeeping, not a page behaviour, and an unbracketed `focusout` from it is F55's exact signature
 * against a page that did nothing wrong. `logSuppressed` records whether that bracket was needed AND
 * applied -- kept SEPARATE from `blurred`, because "we suppressed our own log entry" and "there was no
 * log to suppress" must not collapse into one reading of `blurred: true`, the same discipline the three
 * `blurred` outcomes already get.
 */
focusRevealTest("a control blurred WITH the log bracketed reads logSuppressed:true, and says so", () => {
  const r = focusResetOutcome({ blurred: true, logSuppressed: true, targetMatch: "matched", candidates: 1 });
  focusRevealAssert.equal(r.applied, true);
  focusRevealAssert.equal(r.logSuppressed, true);
  focusRevealAssert.match(r.why, /kept out of the focus-event log/);
});

focusRevealTest("a control blurred with NO log installed reads logSuppressed:false, and is not mistaken for a failed bracket", () => {
  // `probeFocus` off means the listener never installs at all, so nothing was at risk -- this is the
  // ordinary, safe case and must read differently from a bracket that was needed and did not apply.
  const r = focusResetOutcome({ blurred: true, logSuppressed: false, targetMatch: "matched", candidates: 1 });
  focusRevealAssert.equal(r.applied, true);
  focusRevealAssert.equal(r.logSuppressed, false);
  focusRevealAssert.match(r.why, /no focus-event log was installed to suppress/);
  focusRevealAssert.doesNotMatch(r.why, /kept out of the focus-event log/,
    "suppressed and not-installed must not share a reason string");
});

focusRevealTest("logSuppressed is false whenever applied is false, regardless of what the page reported", () => {
  focusRevealAssert.equal(focusResetOutcome({ blurred: null, logSuppressed: true, targetMatch: "matched", candidates: 1 }).logSuppressed, false);
  focusRevealAssert.equal(focusResetOutcome({ blurred: false, logSuppressed: true, targetMatch: "matched", candidates: 1 }).logSuppressed, false,
    "nothing was blurred, so there is nothing a suppression claim could refer to");
  focusRevealAssert.equal(focusResetOutcome({ blurred: true, logSuppressed: true, targetMatch: "fallback", candidates: 3 }).logSuppressed, false,
    "a suspect target discredits the whole reset, including any suppression it claims to have done");
});

/**
 * AN UNTRUSTED BASELINE MUST NOT READ AS "NOTHING APPEARED" — issue #76, measured 2026-09-06.
 *
 * `probeFocusContext` presses Tab before this probe runs, which OPENS a panel revealed on focus.
 * `anchorToTop` then presses Escape. On a CONFORMANT page that closes the panel, so the baseline is clean
 * and the probe measures correctly; on a FAILING page Escape does nothing — the failure under test — so
 * the panel is still open, the census does not grow, and the verdict read `revealed: false`, which is what
 * a conformant page looks like.
 *
 * Both halves of the 1.4.13 fixture came back clean on the real-page path, for opposite reasons:
 *
 *   good.html   revealed:true  focusHeld:true  dismissed:true     correct
 *   bad.html    revealed:false why:"nothing appeared on focus"    blind
 *
 * `packages/cli/src/cli.ts` runs both probes, so that is the product path, not a corpus quirk.
 */
const census = (link: number) => ({ landmark: 0, heading: 0, link, graphic: 0, formControl: 0 });

focusRevealTest("an EMPTY growth on an untouched baseline still reads false — the ordinary conformant page", () => {
  const v = focusRevealVerdict({
    before: census(0), onFocus: census(0), afterEscape: census(0),
    focusBefore: "a", focusAfter: "a", baselineUntouched: true,
  });
  focusRevealAssert.equal(v.revealed, false);
  focusRevealAssert.equal(v.why, "nothing appeared on focus");
});

focusRevealTest("an EMPTY growth on a TOUCHED baseline reads null, never false", () => {
  // This is the bad fixture half exactly: the panel was already open when `before` was taken, so no
  // delta was possible. "Nothing appeared" and "we could not ask" stop sharing a value.
  const v = focusRevealVerdict({
    before: census(1), onFocus: census(1), afterEscape: census(1),
    focusBefore: "a", focusAfter: "a", baselineUntouched: false,
  });
  focusRevealAssert.equal(v.revealed, null);
  focusRevealAssert.match(String(v.why), /baseline was not the untouched document/);
});

focusRevealTest("a TOUCHED baseline that STILL grew is unaffected — the good fixture half keeps its verdict", () => {
  // The narrowness is the design. A baseline that grew has proved itself adequate BY GROWING, so
  // refusing on `focusReset.applied` alone would blind the conformant page too — trading one silent
  // wrong answer for a louder one.
  const v = focusRevealVerdict({
    before: census(0), onFocus: census(1), afterEscape: census(0),
    focusBefore: "trigger", focusAfter: "trigger", baselineUntouched: false,
  });
  focusRevealAssert.equal(v.revealed, true);
  focusRevealAssert.equal(v.focusHeld, true);
  focusRevealAssert.equal(v.dismissed, true);
});

focusRevealTest("baselineUntouched DEFAULTS to trusted, so every existing caller is unchanged", () => {
  // The dataset path runs neither probeFocusContext nor probeNavigation, so its baseline genuinely is
  // untouched and its 15 corpus firings must not move. An opt-in default is what keeps that true.
  const v = focusRevealVerdict({
    before: census(0), onFocus: census(0), afterEscape: census(0),
    focusBefore: "a", focusAfter: "a",
  });
  focusRevealAssert.equal(v.revealed, false);
});

focusRevealTest("a failed census still wins over an untrusted baseline — absence of a reading is the stronger fact", () => {
  // `census unavailable` means the CDP socket did not answer, which is not a statement about the page at
  // all. Reporting the baseline complaint instead would name the wrong cause.
  const v = focusRevealVerdict({
    before: { error: "socket" }, onFocus: census(0), afterEscape: census(0),
    focusBefore: "a", focusAfter: "a", baselineUntouched: false,
  });
  focusRevealAssert.equal(v.revealed, null);
  focusRevealAssert.equal(v.why, "census unavailable");
});

focusRevealTest("the PROBE passes the baseline's trust to the verdict — a source check, like the ordering one above", () => {
  // The verdict is pure and unit-tested; the WIRING is `.mjs` that needs NVDA to exercise, so there is no
  // other way to catch it. Mutation-checked: replacing the expression with a literal `true` fails here,
  // and nothing else in the suite notices — which is precisely why this test exists rather than being
  // left to the four verdict tests above.
  const source = readFileSync(resolve(import.meta.dirname, "./capture-probes.mjs"), "utf8");
  const call = source.indexOf("focusRevealVerdict({");
  focusRevealAssert.ok(call >= 0,
    "the call to focusRevealVerdict is gone from capture-probes.mjs -- this test examines nothing; find "
    + "where the verdict is computed now and assert the wiring there");
  const args = source.slice(call, call + 400);
  focusRevealAssert.match(args, /baselineUntouched:\s*focusReset\?\.applied !== true/,
    "the probe must hand the verdict the baseline's trust, derived from `focusReset.applied` -- passing a "
    + "literal restores issue #76, where a failing page reads exactly like a conformant one");
});

/**
 * #1506: FOCUS AND TIME ARE SEPARATE VARIABLES.
 *
 * `walkToReveal` used to credit the first tab stop whose census had grown since ONE `before` read taken before any
 * Tab, so content a late script or an on-scroll element added while the walk ran was credited to whichever control
 * happened to be focused at that stop (worker-judge's #1043 caselaw reading, 5657882063). The walk now re-reads the
 * census IMMEDIATELY BEFORE each Tab (`control`), and focus is credited only with what grew between that read and
 * the read after the Tab. Content already present at `control` arrived on its own.
 *
 * What remains unseparated, stated rather than hidden: content that arrives on its own DURING the Tab interval
 * itself (a few hundred ms) is still indistinguishable by count from a reveal. The interval is now one stop wide
 * instead of the whole walk.
 */
const LATE = { ...BASE, link: 4 };                       // a link a script added, with no focus change
const LATE_AND_REVEALED = { ...LATE, heading: 2 };       // that late link, plus a heading focus revealed
const named = (census: Record<string, unknown>, names: string[]) => ({ ...census, names });

focusRevealTest("#1506 (a): content that grew with NO focus change reads NOT revealed", () => {
  const v = focusRevealVerdict({ before: BASE, control: LATE, onFocus: LATE, afterEscape: LATE,
    focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, false, "the census grew before the Tab, so focus did not cause it");
  focusRevealAssert.match(String(v.why), /before the tab|without a focus change|on its own/i);
});

focusRevealTest("#1506 (b): a genuine focus reveal still reads revealed, and records what grew by count AND name", () => {
  const v = focusRevealVerdict({
    before: named(BASE, ["Search", "Help"]), control: named(BASE, ["Search", "Help"]),
    onFocus: named({ ...BASE, heading: 2 }, ["Search", "Help", "Password rules"]),
    afterEscape: named({ ...BASE, heading: 2 }, ["Search", "Help", "Password rules"]),
    focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, true);
  focusRevealAssert.deepEqual(v.revealedBy, [["heading", 1]]);
  focusRevealAssert.deepEqual(v.revealedNames, ["Password rules"], "the evidence carries its own proof");
});

focusRevealTest("#1506 (c): content that grew on BOTH reads is not credited to focus; only what grew after the Tab is", () => {
  const both = focusRevealVerdict({ before: BASE, control: LATE, onFocus: LATE, afterEscape: BASE,
    focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(both.revealed, false, "the same growth on the control read and the focus read is time, not focus");
  const onTop = focusRevealVerdict({ before: BASE, control: LATE, onFocus: LATE_AND_REVEALED, afterEscape: LATE,
    focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(onTop.revealed, true, "a reveal on top of late content is still found");
  focusRevealAssert.deepEqual(onTop.revealedBy, [["heading", 1]], "and credited with the heading only, not the late link");
});

focusRevealTest("#1506: names are a MULTISET difference -- a second element sharing a name already on the page still appeared", () => {
  // Real pages repeat names heavily (75% of named elements share a name with another, measured 2026-08-29), so a
  // set difference would report a revealed "Help" link as nothing when the page already had one.
  focusRevealAssert.deepEqual(namesThatAppeared({ names: ["Help", "Search"] }, { names: ["Help", "Search", "Help"] }), ["Help"]);
  focusRevealAssert.deepEqual(namesThatAppeared({ names: ["Help"] }, { names: ["Help"] }), [], "nothing new is nothing");
  focusRevealAssert.deepEqual(namesThatAppeared({ heading: 1 }, { names: ["Help"] }), [], "a read with no names is not a claim");
});

focusRevealTest("#1506: a verdict without a control read keeps the old single-baseline comparison, and says so", () => {
  // Callers from before #1506 pass no `control`. Absent is not a reading: the comparison falls back to `before`
  // and the verdict names that it could not separate focus from time, rather than claiming it did.
  const v = focusRevealVerdict({ before: BASE, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(v.revealed, true);
  focusRevealAssert.equal(v.timeSeparated, false);
  const w = focusRevealVerdict({ before: BASE, control: BASE, onFocus: GREW, afterEscape: BASE, focusBefore: "a", focusAfter: "a" });
  focusRevealAssert.equal(w.timeSeparated, true);
});

focusRevealTest("#1506: the walk reads the census BEFORE each Tab and credits only growth since that read", () => {
  const source = readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8");
  const start = source.indexOf("async function walkToReveal(");
  const end = source.indexOf("\n}\n", start);
  focusRevealAssert.ok(start !== -1 && end > start, "the positive control: walkToReveal is found");
  const walk = source.slice(start, end);
  const control = walk.indexOf("control = await structuralCensus()");
  const tab = walk.indexOf('nvda.press("Tab")');
  focusRevealAssert.ok(control !== -1 && tab !== -1 && control < tab, "the control read comes before the Tab it controls for");
  focusRevealAssert.ok(walk.includes("censusGrowth(control, onFocus)"), "growth is measured from the control read");
  focusRevealAssert.ok(!walk.includes("censusGrowth(before, onFocus)"), "not from the walk's single baseline");
});
