/**
 * `walkToReveal` FINDS THE PANEL FROM A TAB DEPTH THE CORPUS HAS NEVER USED — #2121, split off #1865's
 * clause 3.
 *
 * WHY THIS FILE EXISTS, IN ONE MEASUREMENT. All fifteen `focus-panel-undismissable-*`/`focus-panel-stuck*`
 * corpus pages put the panel trigger as the SECOND of three focusable controls
 * (`packages/lab/src/training/case-matrix.mjs`), so every capture this project has ever taken returned from
 * stop 0 or stop 1. `FOCUS_REVEAL_STOPS` is 8. Stops 2-7 of that loop — the bound itself, the per-stop
 * control read on a later pass, the `reportFocusedControlWithRetry` bail-out on a later pass, and the
 * `deadline` break on a later pass — had therefore never executed ANYWHERE, and no corpus case could make
 * them: a case at stop 5 reaches stop 5, once, and costs a fleet window to author (#1926's clause 4, behind
 * a ~4.5 h recapture). A driven walk reaches the whole bound in milliseconds with no fleet at all.
 *
 * AND THE OBSTACLE THAT SAID IT COULD NOT BE DONE IS GONE. `tab-probe-start-position.test.ts` next door
 * read, until this PR corrected it, "Neither probe can be driven without real NVDA — `capture-core.mjs`
 * imports guidepup, which throws at module load with no screen reader present". #1772 made that binding
 * lazy (`capture-probes.mjs` imports `nvda`/`ensureGuidepup` from `capture-setup.mjs` instead), and this
 * file importing and CALLING the walk on a screen-reader-free Linux host is the demonstration. A
 * source-read guard was the right tool while the import threw; it is not the right tool now.
 *
 * WHAT THIS FILE DOES NOT CLAIM, and the distinction is the whole of #1865's remaining half. A fake page
 * proves the WALK'S ARITHMETIC — that the loop reaches the depth it says it reaches, stops where it says it
 * stops, and reports "ran out" apart from "nothing there". It cannot prove NVDA's: whether a real Tab on a
 * real box lands where this fake says it lands stays on #1865 and stays `orchestrator`'s to report. Both
 * are wanted; neither substitutes for the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { walkToReveal } from "./capture-probes.mjs";
import { censusGrowth, focusRevealVerdict } from "./capture-pure.mjs";

/** The bound under test, restated so a mutation of `FOCUS_REVEAL_STOPS` shows up as a DISAGREEMENT here. */
const STOPS = 8;

/** A structural census, keyed on `REVEALABLE_ROLES` -- the counts `censusGrowth` compares. */
type Census = Record<"formControl" | "link" | "graphic" | "heading" | "landmark", number>;

/** A census with nothing revealed. `formControl` is the page's own furniture, present throughout. */
const QUIET: Census = Object.freeze({ formControl: 3, link: 0, graphic: 0, heading: 0, landmark: 0 });

interface FakePage {
  /** Zero-based tab stop whose control reveals content while it holds focus; `-1` for a page that reveals nothing. */
  triggerAt: number;
  /** Zero-based stop at which the focus read starts coming back empty, as a real timed-out read does. */
  bailAt?: number;
  /** Number of Tabs already pressed when the walk's own deadline is first read as crossed. */
  deadlineAfter?: number;
}

/** A fixed fake instant. Nothing here reads the real clock, so nothing here is timing-dependent. */
const DEADLINE = 1_000;

/**
 * Drive `walkToReveal` over a fake page and return what the walk saw plus what the page recorded.
 *
 * THE FAKE MODELS ONE FACT AND NO MORE: content is present in the census exactly while the trigger holds
 * focus. That is the property 1.4.13's "content on focus" names, and it is the only property the walk's
 * arithmetic consumes — `censusGrowth` between the read before a Tab and the read after it. A fake that
 * modelled more would be asserting against its own invention.
 */
async function drive({ triggerAt, bailAt, deadlineAfter }: FakePage) {
  // -1 is "the document, nothing focused yet". The walk's n-th Tab lands on stop n-1.
  let focus = -1;
  let pressed = 0;
  // Every call the walk makes, in order -- what a source read of this loop could only approximate.
  const calls: string[] = [];
  const censusNow = (): Census => ({ ...QUIET, link: focus === triggerAt ? 1 : 0 });
  const before = censusNow();
  const result = await walkToReveal({
    interaction: { sweepLog: [] },
    deadline: DEADLINE,
    io: {
      press: async () => { calls.push("press"); focus += 1; pressed += 1; },
      census: async () => { calls.push("census"); return censusNow(); },
      // An empty string, not `false`: `reportFocusedControlWithRetry` returns NVDA's spoken phrase, and a
      // read that came back with nothing to say is the falsy value the walk actually meets.
      reportFocus: async () => {
        calls.push("reportFocus");
        return bailAt !== undefined && focus >= bailAt ? "" : `stop ${focus}`;
      },
      // Read at the TOP of each stop, before that stop's Tab — so `pressed` is the stop index there.
      now: () => (deadlineAfter !== undefined && pressed >= deadlineAfter ? DEADLINE + 1 : DEADLINE),
    },
  });
  return { ...result, before, pressed, calls };
}

/**
 * The verdict `probeFocusReveal` would reach from this walk, on a page that DOES dismiss on Escape.
 *
 * Called rather than restated: "both depths report `revealed: true`" is #1865's clause 3 verbatim, and
 * asserting it against `focusRevealVerdict` asserts it against the function that decides it in production.
 */
function verdictFrom({ before, control, onFocus }: { before: unknown; control: unknown; onFocus: unknown }) {
  return focusRevealVerdict({
    before, control, onFocus,
    afterEscape: QUIET,
    focusBefore: "the trigger", focusAfter: "the trigger",
  });
}

test("stop 0: the trigger is the first focusable control", async () => {
  const walk = await drive({ triggerAt: 0 });
  assert.equal(walk.revealedAt, 0);
  assert.equal(walk.tabs, 1, "one Tab reached it, so one Tab is what the walk must record");
  assert.deepEqual(censusGrowth(walk.control, walk.onFocus), [["link", 1]],
    "the growth is credited to the control the walk stopped on -- the per-stop read taken immediately " +
    "before ITS Tab (#1506), not the probe's single baseline");
  assert.equal(verdictFrom(walk).revealed, true);
});

test("stop 5: the same verdict from a depth no corpus case has ever used -- #1865's literal claim", async () => {
  const walk = await drive({ triggerAt: 5 });
  assert.equal(walk.revealedAt, 5,
    "a walk that only works two Tabs in reports -1 here, which is the silent failure #1865 exists to catch");
  assert.equal(walk.tabs, 6);
  assert.deepEqual(censusGrowth(walk.control, walk.onFocus), [["link", 1]]);
  assert.equal(verdictFrom(walk).revealed, true,
    "SAME verdict as stop 0. The depth the panel sits at is not allowed to change the answer");
});

test("stop 7, the last iteration inside the bound: found, not missed", async () => {
  const walk = await drive({ triggerAt: STOPS - 1 });
  assert.equal(walk.revealedAt, STOPS - 1,
    "an off-by-one at the loop edge makes the deepest reachable control invisible -- the failure this " +
    "whole chain is about");
  assert.equal(walk.tabs, STOPS);
  assert.equal(verdictFrom(walk).revealed, true);
});

/**
 * THE NEGATIVE CONTROL, and it is the point.
 *
 * Every assertion above passes on a walk that always returns not-found for the trivial reason that it also
 * always returns not-found. This is the case that cannot: the page is identical to the one above except
 * that its trigger sits ONE stop past the bound, and the walk must come back with the SAME `tabs` and the
 * OPPOSITE `revealedAt`. #2055 refused a corpus case AT the bound for exactly this reason -- "the walk ran
 * out" and "nothing revealed" are two different claims, and `tabs` alone cannot tell them apart.
 */
test("stop 8, one past the bound: ran out, which is not the same claim as nothing revealed", async () => {
  const walk = await drive({ triggerAt: STOPS });
  assert.equal(walk.revealedAt, -1);
  assert.equal(walk.tabs, STOPS,
    "the walk spent its whole budget: `tabs` at the bound with `revealedAt` -1 is what 'we ran out' looks " +
    "like, and it is why `tabs` is on the mark rather than folded into the verdict");
  assert.equal(verdictFrom(walk).revealed, false);
});

test("the focus read bailing out on a LATER pass stops the walk without inventing a reveal", async () => {
  // The trigger is at stop 6, past the bail. A walk that kept going, or that credited a census it never
  // confirmed focus for, would report it.
  const walk = await drive({ triggerAt: 6, bailAt: 4 });
  assert.equal(walk.revealedAt, -1, "the walk never read stop 4's focus, so it may not report stop 6's panel");
  assert.equal(walk.tabs, 5, "stop 4's Tab was pressed before the read failed, and the count says so");
  // `onFocus` IS set here, and that is the subtle half. Stops 0-3 each confirmed focus and took their
  // post-Tab census, so the walk carries stop 3's reading out -- while `control` is stop 4's PRE-Tab read,
  // taken one stop later. The pair straddles the bail, and the only thing that keeps the probe honest is
  // that neither grew. `probeFocusReveal` branches on `!onFocus` to say "nothing focusable on this page",
  // so a bail-out at stop 4 is deliberately NOT that finding: something was focusable, the walk simply
  // stopped being able to read it.
  assert.deepEqual(censusGrowth(walk.control, walk.onFocus), [],
    "the two censuses the walk carries out straddle the bail-out, and a growth read across them would be " +
    "credited to a stop whose focus was never confirmed");
  assert.equal(verdictFrom(walk).revealed, false);
});

test("the deadline crossing on a LATER pass records the Tabs pressed, not the bound", async () => {
  const walk = await drive({ triggerAt: 6, deadlineAfter: 3 });
  assert.equal(walk.revealedAt, -1);
  assert.equal(walk.tabs, 3,
    "three Tabs actually happened. Reporting the bound here would say the page was walked to depth 8 and " +
    "revealed nothing, which is a conformance claim the walk did not earn");
  assert.notEqual(walk.tabs, STOPS);
});

/**
 * #1506's ordering claim, OBSERVED rather than read out of the source.
 *
 * `focus-reveal.test.ts` pins this by searching `walkToReveal`'s text for the control read before the Tab,
 * which is what was available while the walk could not be called. It can be called now, so the same claim
 * is available as the sequence the walk actually performs — and a sequence cannot be satisfied by a line
 * that merely appears earlier in the file. Both are kept: a source read survives a refactor that a fake
 * would have to be re-taught, and this one survives a rename the source read would not notice.
 */
test("#1506: each stop reads the census BEFORE its Tab, and again after the focus it confirmed", async () => {
  const walk = await drive({ triggerAt: 1 });
  assert.deepEqual(walk.calls, [
    "census", "press", "reportFocus", "census",   // stop 0 -- nothing grew, so the walk goes on
    "census", "press", "reportFocus", "census",   // stop 1 -- the trigger, and the walk stops here
  ], "the per-stop control read must come before the Tab it controls for (#1506): content that arrived " +
     "between the probe's baseline and this read belongs to time, not to focus");
});

test("a page that reveals nothing anywhere: the whole budget, and an honest nothing", async () => {
  const walk = await drive({ triggerAt: -1 });
  assert.equal(walk.revealedAt, -1);
  assert.equal(walk.tabs, STOPS);
  assert.equal(walk.pressed, STOPS, "every stop in the bound was actually walked");
  assert.equal(verdictFrom(walk).revealed, false);
});
