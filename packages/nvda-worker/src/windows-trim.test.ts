// This module removes things from a Windows guest unattended. The failure it must never have is
// removing Edge or the speech stack: a guest without them does not fail loudly, it produces empty
// transcripts that look exactly like the NVDA mute faults this project has already spent days chasing.
// So the keep-list precedence is asserted first and hardest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  packagesToRemove, trimSummary, trimAlreadyDone, REMOVABLE_APPX, KEEP_PATTERNS, DISABLEABLE_SERVICES,
} from "./windows-trim.mjs";

test("the keep-list beats the removable list, always", () => {
  // The precedence that makes this safe to run unattended. If a package is somehow on both lists,
  // keeping it is the only acceptable resolution.
  const installed = ["Microsoft.BingNews_8wekyb3d8bbwe", "Microsoft.Edge.SpeechRuntime_8wekyb3d8bbwe"];
  const removed = packagesToRemove(installed);
  assert.ok(!removed.some((p) => p.toLowerCase().includes("edge")));
  assert.ok(!removed.some((p) => p.toLowerCase().includes("speech")));
});

test("nothing NVDA or Edge depends on is ever removed", () => {
  // The concrete list nano11builder deletes and we must not: Edge itself, and the LanguageFeatures
  // speech packages that provide the `oneCore` synth NVDA is configured to use.
  const critical = [
    "Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe",
    "Microsoft-Windows-LanguageFeatures-Speech-en-us-Package",
    "Microsoft-Windows-LanguageFeatures-TextToSpeech-en-us-Package",
    "Microsoft.WebMediaExtensions_8wekyb3d8bbwe",
    "Microsoft.UI.Xaml.2.8_8wekyb3d8bbwe",
    "Microsoft.VCLibs.140.00_8wekyb3d8bbwe",
    "Microsoft.NET.Native.Runtime.2.2_8wekyb3d8bbwe",
    "Microsoft.Windows.NarratorQuickStart_8wekyb3d8bbwe",
  ];
  assert.deepEqual(packagesToRemove(critical), [], "a trimmed guest must still be able to capture");
});

test("the background apps that keep RuntimeBroker resident are removed", () => {
  const installed = [
    "Microsoft.BingNews_4.55.ature_x64__8wekyb3d8bbwe",
    "Microsoft.XboxGamingOverlay_5.721.10202.0_x64__8wekyb3d8bbwe",
    "MicrosoftTeams_24004.1309.2657.7439_x64__8wekyb3d8bbwe",
    "Clipchamp.Clipchamp_2.5.2_neutral_~_yxz26nhyzhsrt",
  ];
  assert.equal(packagesToRemove(installed).length, 4);
});

test("packages are matched from the installed list, not assumed", () => {
  // nano11builder hardcodes `amd64~~10.0.22621.1265` into its package names, which is why it is
  // x64-only. These guests are ARM64, so the suffix must never be part of the match.
  const arm = ["Microsoft.BingWeather_4.53.33420.0_arm64__8wekyb3d8bbwe"];
  assert.deepEqual(packagesToRemove(arm), arm);
});

test("an unknown package is left alone", () => {
  // Default-deny: only things explicitly listed go. Anything a future Windows build adds stays until
  // somebody decides otherwise.
  assert.deepEqual(packagesToRemove(["Contoso.SomethingNew_1.0_arm64__abc"]), []);
});

test("an empty or already-trimmed guest yields nothing to do", () => {
  assert.deepEqual(packagesToRemove([]), []);
});

test("no audio service is on the disable list", () => {
  // Speech is captured as text over NVDA Remote, so disabling audio looks free. It is not: NVDA's synth
  // initialises against the audio stack and a synth that fails to start is indistinguishable from the
  // mute fault. ~20 MB is not worth reintroducing that ambiguity.
  const names = DISABLEABLE_SERVICES.map((s) => s.name.toLowerCase());
  for (const forbidden of ["audiosrv", "audioendpointbuilder", "audio"]) {
    assert.ok(!names.some((n) => n.includes(forbidden)), `${forbidden} must not be disabled`);
  }
});

test("every disabled service explains itself", () => {
  // A list of service names with no reasons is a list nobody can safely edit later.
  for (const s of DISABLEABLE_SERVICES) {
    assert.ok(s.why && s.why.length > 10, `${s.name} needs a reason`);
  }
});

test("the update services are disabled together", () => {
  // Disabling wuauserv alone does nothing lasting: UsoSvc restarts it and WaaSMedicSVC repairs it back
  // to enabled. All three or none.
  const names = DISABLEABLE_SERVICES.map((s) => s.name);
  for (const n of ["wuauserv", "UsoSvc", "WaaSMedicSVC"]) assert.ok(names.includes(n));
});

test("the removable list carries no critical package by mistake", () => {
  // Guards the list itself rather than the filter, so a careless future addition fails here.
  for (const pkg of REMOVABLE_APPX) {
    assert.ok(
      !KEEP_PATTERNS.some((k) => pkg.toLowerCase().includes(k)),
      `${pkg} is on the removable list but matches a keep pattern`,
    );
  }
});

test("the summary states what happened, including failures", () => {
  assert.equal(trimSummary({ skipped: true }), "already trimmed");
  assert.match(trimSummary({ removed: ["a", "b"], disabled: ["WSearch"] }), /2 app\(s\) removed/);
  assert.match(trimSummary({ removed: [], disabled: [], failed: ["WinDefend"] }), /1 failed \(WinDefend\)/);
});

test("a summary says so when the trim could not run for want of elevation", () => {
  // The failure that actually happened: the worker task is RunLevel Limited, every DISM and sc.exe call
  // needs elevation, and the child died on its first step for three boots with stdio ignored. "skipped"
  // and "skipped because it is not allowed to run" are different facts and must read differently.
  assert.match(trimSummary({ needsElevation: true }), /needs elevation/);
  assert.notEqual(trimSummary({ needsElevation: true }), trimSummary({ skipped: true }));
});

test("a marker recording 'needs elevation' does not count as done", () => {
  // The bug this fixes: the first unelevated attempt wrote a marker, and every boot afterwards saw a
  // marker and returned early — so the escalation path added later could never run. "Attempted" and
  // "done" must read differently here, exactly as they do in trimSummary.
  const dir = mkdtempSync(resolve(tmpdir(), "a11y-trim-"));
  try {
    const m = resolve(dir, "marker");
    writeFileSync(m, "2026-08-02T00:00:00Z skipped: needs elevation — could not register\n");
    assert.equal(trimAlreadyDone(m), false);
    writeFileSync(m, "2026-08-02T00:00:00Z 12 app(s) removed, 11 service(s) disabled\n");
    assert.equal(trimAlreadyDone(m), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no marker at all is not done", () => {
  assert.equal(trimAlreadyDone(resolve(tmpdir(), "definitely-not-here-a11y")), false);
});
