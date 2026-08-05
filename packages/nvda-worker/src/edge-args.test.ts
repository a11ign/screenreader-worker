// What Edge is told at launch decides whether a capture describes the PAGE or the profile. These are
// flags rather than registry policies precisely because policies drift: StartupBoostEnabled read 1 on
// two guests and 0 on a third for weeks, and nothing noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeArgs } from "./capture-pure.mjs";

const args = () => edgeArgs("http://pages/case/good");

test("autofill is suppressed, because probeForms teaches the profile", () => {
  // probeForms SUBMITS forms; Edge then offers to remember the values, and later pages get a
  // suggestion icon inside recognised inputs which NVDA announces as an embedded object. The rate
  // rose from 3% to 31% across the corpus as the profile learned.
  const features = args().find((a) => a.startsWith("--disable-features="))!;
  assert.match(features, /AutofillServerCommunication/);
  assert.match(features, /AutofillAddressProfileSavePrompt/);
});

test("there is exactly ONE --disable-features flag", () => {
  // Chromium takes the LAST --disable-features and ignores earlier ones. Adding a second flag rather
  // than extending the list silently disables only half of what you asked for.
  assert.equal(args().filter((a) => a.startsWith("--disable-features=")).length, 1);
});

test("the welcome page stays suppressed alongside the new features", () => {
  // The regression the single-flag rule protects: msEdgeWelcomePage was there first, and losing it
  // resurfaces the "Welcome to Microsoft Edge" phantom captures.
  assert.match(args().find((a) => a.startsWith("--disable-features="))!, /msEdgeWelcomePage/);
});

test("--app is still used, and still carries the URL", () => {
  // --app is what makes the window chromeless. Without it NVDA's quick-nav wanders out of the document
  // into browser UI, which is the original cause of captures reading Edge's own chrome.
  assert.ok(args().includes("--app=http://pages/case/good"));
});

test("first-run and crash bubbles stay suppressed", () => {
  for (const flag of ["--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble"]) {
    assert.ok(args().includes(flag), `${flag} is load-bearing for a clean first line`);
  }
});

test("the durable profile directory is still passed", () => {
  assert.ok(args().some((a) => a.startsWith("--user-data-dir=")));
});

test("Edge's image magnifier is suppressed", () => {
  // Magnify opens a full-window overlay on Ctrl pressed twice while the pointer is over an image, and
  // guidepup sends Ctrl before EVERY captured action. On gov.uk the overlay took the foreground and the
  // capture read "Image Magnify, document" instead of the page — so the run reported that it could not
  // read the site at all. Microsoft documents no policy for this, only a per-profile toggle, which is
  // why it is a flag: `pointer.mjs` is the second, independent guard.
  assert.match(args().find((a) => a.startsWith("--disable-features="))!, /msEdgeImageMagnifyUI/);
});
