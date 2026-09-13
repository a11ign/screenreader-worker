// #1363, THE CAPTURE-TIME HALF: the probe never activates a control inside embedded content, an activation that
// leaves the page's site is recognised and recorded, and the capture stops there.
//
// Rehearsal 2 (#915) on https://www.w3.org/WAI with the task "Learn about web accessibility": the form-field
// sweep's first field was the W3C's embedded YouTube player, its name shares the task's word, and activating
// it replaced the tab with youtube.com. The capture then pressed Search, Subscribe and YouTube Home there, and
// the report attributed youtube.com's evidence to w3.org.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { announcesANewWindow, leftSiteReason } from "@a11ign/evidence";
import { stripComments } from "@a11ign/evidence/source-text";
import {
  activationLeftTheSite, leftTheOrigin, markLeftSite, notRunAfterLeaving, probeKindFor, recordWhatWasAsked,
} from "./capture-pure.mjs";

// Quoted from run 34767932873's `a11ign-result.json`, `structure.formFields[0]`.
const EMBED = "main landmark, Web Accessibility Perspectives: Video Captions, region, Video, frame, clickable, "
  + "thumbnail-image, graphic, button";
const TASK = "Learn about web accessibility";
const W3C = "https://www.w3.org/WAI/";

test("#1363: the rehearsal's embedded YouTube player is REFUSED, although its name shares the task's word", () => {
  assert.equal(probeKindFor(EMBED, { probeForms: true, task: TASK }), null);
});

test("#1363 CONTROL: the same button OUTSIDE a frame is still activated as the task's button", () => {
  const outside = EMBED.replace(", frame,", ",");
  assert.notEqual(outside, EMBED, "the fixture really removed the frame role");
  assert.equal(probeKindFor(outside, { probeForms: true, task: TASK }), "task");
});

test("#1363: a disclosure inside a frame and a button in an embedded object are refused too", () => {
  assert.equal(probeKindFor("frame, Menu, button, collapsed", { probeForms: true, task: TASK }), null);
  assert.equal(probeKindFor("Menu, button, collapsed", { probeForms: true, task: TASK }), "disclosure",
    "the control: the same disclosure outside a frame");
  assert.equal(probeKindFor("embedded object, Play, button", { probeForms: true, task: "play" }), null);
});

test("#1363: a button NAMED for a frame is still a button -- the role is matched, not the word", () => {
  assert.equal(probeKindFor("Frame size, button", { probeForms: true, task: "choose a frame size" }), "task");
});

test("#1363: an ORIGIN change is leaving; a path change on the same site is not; an unreadable URL is unknown", () => {
  assert.equal(leftTheOrigin(W3C, "https://www.youtube.com/channel/x"), true);
  assert.equal(leftTheOrigin(W3C, "https://www.w3.org/WAI/fundamentals/"), false);
  assert.equal(leftTheOrigin(W3C, "http://www.w3.org/WAI/"), true, "the scheme is part of the origin");
  assert.equal(leftTheOrigin(W3C, null), false, "the browser could not say: not evidence of leaving");
  assert.equal(leftTheOrigin(W3C, "not a url"), false);
});

test("#1363: the rehearsal's own announcement is an excursion even while the page target's URL is unchanged", () => {
  const left = activationLeftTheSite({
    control: EMBED, kind: "taskButton", after: "Opening new window", from: W3C, now: W3C, phase: "sweep",
  });
  assert.deepEqual(left, {
    control: EMBED, kind: "taskButton", phase: "sweep", from: W3C, to: null, evidence: "Opening new window",
  });
  const moved = activationLeftTheSite({
    control: "You Tube Home, link", kind: "route", after: "", from: W3C, now: "https://www.youtube.com/", phase: "routeChange",
  });
  assert.equal(moved?.to, "https://www.youtube.com/");
  assert.equal(activationLeftTheSite({
    control: "Search, button", kind: "submit", after: "dialog", from: W3C, now: "https://www.w3.org/WAI/search", phase: "sweep",
  }), null, "the control: an activation that stayed on the site records nothing");
});

test("#1363: channels the capture never ran are marked with the reason, overriding what the flags said", () => {
  const observed: Record<string, unknown> = { focusOrder: { asked: true }, headings: { asked: true, complete: true } };
  markLeftSite(observed, { control: EMBED }, ["focusOrder", "links"]);
  assert.deepEqual(observed.focusOrder, { asked: false, why: leftSiteReason({ control: EMBED }) });
  assert.deepEqual(observed.links, { asked: false, why: leftSiteReason({ control: EMBED }) });
  assert.deepEqual(observed.headings, { asked: true, complete: true }, "a channel that ran keeps its record");
});

test("#1363: what never ran is every sweep with no record of its own, plus every channel of a skipped step", () => {
  const observed = { headings: {}, landmarks: {}, formFields: {} };
  assert.deepEqual(notRunAfterLeaving({ observed, skipped: new Set(["postSubmit", "focus", "routeChange"]) }), [
    "graphics", "links", "lists", "frames", "tableCells", "postSubmitFields",
    "focusOrder", "dialogEscape", "arrowNavigation", "typedFeedback", "focusContext", "routeChange",
  ]);
  assert.deepEqual(notRunAfterLeaving({
    observed: { headings: {}, landmarks: {}, formFields: {}, graphics: {}, links: {}, lists: {}, frames: {}, tableCells: {} },
    skipped: new Set(),
  }), [], "the control: a capture that ran everything lists nothing");
});

test("#1363: a skipped focus pass names exactly the focus channels `recordWhatWasAsked` writes", () => {
  const observed: Record<string, { asked: boolean; why?: string }> = {};
  recordWhatWasAsked({ observed, probeForms: false, probeFocus: true, interaction: { formChanges: [] } });
  const written = Object.keys(observed).filter((channel) => !["formChanges", "postSubmitFields", "routeChange"].includes(channel));
  const everySweep = { headings: {}, landmarks: {}, formFields: {}, graphics: {}, links: {}, lists: {}, frames: {}, tableCells: {} };
  assert.deepEqual(notRunAfterLeaving({ observed: everySweep, skipped: ["focus"] }).sort(), written.sort());
});

test("#1363 PARITY: the worker's copy of the new-window grammar answers exactly as @a11ign/evidence's", () => {
  const said = ["Opening new window", "Opening new tab", "opening NEW window, Watch later", "New Tab, button, focused",
    "dialog", "", "Want to subscribe to this channel?"];
  for (const after of said) {
    const worker = activationLeftTheSite({ control: "c", kind: null, after, from: W3C, now: W3C, phase: "sweep" }) !== null;
    assert.equal(worker, announcesANewWindow(after), JSON.stringify(after));
  }
});

/**
 * THE WIRING, READ FROM THE SOURCE -- the exemption `activation-budget-is-wired.test.ts` records, for its reason:
 * `capture-probes.mjs` imports guidepup, which throws at module load where no screen reader exists, so no test
 * can call these functions. COMMENTS ARE STRIPPED FIRST: a comment naming a call is the mutation a prose search
 * agrees with.
 */
const PROBES = stripComments(readFileSync(resolve(import.meta.dirname, "capture-probes.mjs"), "utf8"));

/** The body of one top-level function: from its declaration to the next line that closes a top-level block. */
function bodyOf(name: string): string {
  const start = PROBES.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `capture-probes.mjs no longer declares ${name}`);
  return PROBES.slice(start, PROBES.indexOf("\n}\n", start));
}

test("#1363 WIRING: every sweep activation is followed by the site check, and nothing is pressed once the site is left", () => {
  const budget = bodyOf("activationBudgetFor");
  assert.match(budget, /operateControl\([^)]*\)[\s\S]*?\.then\(\(\) => recordIfLeftTheSite\(/);
  assert.match(budget, /if \(interaction\.leftSite\) return Promise\.resolve\(\);/);
});

test("#1363 WIRING: a sweep stops where the site was left, and the probe sequence skips what would follow", () => {
  assert.match(bodyOf("sweepInDirection"),
    /const mustStop = sweepMustStop\(\{ deadline, ended \}\);\s*if \(mustStop\) return \{ stop: mustStop/);
  assert.match(bodyOf("sweepMustStop"), /if \(ended\?\.\(\)\) return "leftSite";/);
  assert.match(bodyOf("sweepEveryStructuralType"), /onItem: onFormField, deadline, diag, trips, observed, ended \}/);
  const passes = bodyOf("probePasses");
  assert.match(passes, /if \(site\.ended\(\)\) \{ site\.skipped\.add\("postSubmit"\); return; \}/, "the post-submit re-read");
  assert.match(passes, /const runFocus = async \(\) => \{\s*if \(site\.ended\(\)\) \{ site\.skipped\.add\("focus"\); return; \}/,
    "the focus pass, at its own start -- `runProbeSequence` is left exactly as it was");
  const navigate = bodyOf("navigateByStructure");
  assert.match(navigate, /const site = await watchTheSite\(interaction\);/);
  assert.match(navigate, /probeRouteChange\(\{ interaction, deadline, diag \}\) : null;\s*await watchTheRouteChange\(/);
  assert.match(navigate, /if \(interaction\.leftSite\) markTheExcursion\(/);
  assert.match(bodyOf("markTheExcursion"), /markLeftSite\(observed, leftSite, notRunAfterLeaving\(/);
  assert.match(bodyOf("watchTheRouteChange"),
    /recordIfLeftTheSite\(\{ phrase: control, interaction, from: site\.pageUrl, phase: "routeChange"/);
  assert.match(bodyOf("interactionEvidence"), /\.\.\.\(interaction\.leftSite \? \{ leftSite: interaction\.leftSite \} : \{\}\)/);
});
