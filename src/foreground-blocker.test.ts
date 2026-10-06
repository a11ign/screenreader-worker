// A MODAL BLOCKS INPUT; A TOAST BLOCKS FOCUS. ONLY THE FIRST WAS CHECKED.
//
// a11y-worker-6, 2026-09-02: a `ShellExperienceHost` notification toast held the foreground for three and
// a half hours. Edge could never take focus, so every capture wedged -- and because a toast is NOT A
// MODAL, `listBlockingDialogs` returned nothing, `noBlockingDialog` stayed true, and the worker
// advertised itself `ready` for the whole outage. From the run's side that is indistinguishable from a
// slow page, so it waited, and a corpus recapture made no progress at all.
//
// The predicate is pure and lives apart from the PowerShell that feeds it, which is the only reason any
// of this is testable off Windows -- the same split that makes `chooseProbe` and `failIfScreenReaderIsMute`
// testable.
import { test } from "node:test";
import assert from "node:assert/strict";

// A `.mjs` module with JSDoc types, imported from a `.ts` test exactly as the worker's other tests do —
// `checkJs` resolves it, so no suppression is needed and adding one is itself a type error.
import { foregroundBlocker, FOREGROUND_BLOCKERS } from "./desktop-dialogs.mjs";

test("the toast that caused the outage is caught", () => {
  const blocker = foregroundBlocker({ title: "New notification", owner: "ShellExperienceHost.exe", ok: true });
  assert.ok(blocker, "the specimen this check exists for must be caught");
  assert.equal(blocker.owner, "ShellExperienceHost.exe");
  // The OWNER and the TITLE, because "not ready: noForegroundBlocker" names the check and not the fault --
  // the distinction `blockingDialogs` already makes for modals.
  assert.equal(blocker.title, "New notification");
});

test("an ordinary idle desktop is NOT a fault", () => {
  // The predicate this replaced would have been "the foreground is not Edge", which is true on every idle
  // guest in the fleet: an idle desktop's foreground belongs to explorer, and a capture launches Edge into
  // the foreground from there perfectly well. Gating on that would have taken the whole fleet offline to
  // fix a fault that happened once.
  assert.equal(foregroundBlocker({ title: "", owner: "explorer.exe", ok: true }), null);
  assert.equal(foregroundBlocker({ title: "example.com", owner: "msedge.exe", ok: true }), null);
});

test("an UNREADABLE probe is not a fault, and that is deliberate", () => {
  // `null` for fine and `null` for unknown looks like the ambiguity this repo refuses everywhere else, and
  // is the opposite: an unreadable diagnostic must never take a worker offline. It is the rule
  // `foregroundLockTimeout` and `noBlockingDialog` already follow. Breaking it would let a PowerShell
  // probe that timed out on a busy guest sideline a healthy machine -- trading a fault that happened once
  // for one that happens under load.
  assert.equal(foregroundBlocker({ title: "", owner: "", ok: false }), null);
  assert.equal(foregroundBlocker(null), null);
  assert.equal(foregroundBlocker(undefined), null);
});

test("the owner matches with or without .exe, and whatever the casing", () => {
  // Windows reports the owner both ways depending on how it was resolved. A comparison that missed one
  // form would fail exactly when it mattered and pass every test written against the other.
  for (const owner of ["ShellExperienceHost", "shellexperiencehost.exe", "SHELLEXPERIENCEHOST"]) {
    assert.ok(foregroundBlocker({ title: "t", owner, ok: true }), `${owner} must be recognised`);
  }
});

test("the blocker list is real and non-empty", () => {
  // This suite would otherwise pass having examined nothing if the list were emptied -- the count-based
  // check this repo keeps rediscovering.
  assert.ok(FOREGROUND_BLOCKERS.length >= 1);
  assert.ok(FOREGROUND_BLOCKERS.includes("ShellExperienceHost"),
    "the one entry with an incident behind it must stay");
});
