// What the browser is told at launch decides whether a capture describes the PAGE or the profile. These are
// flags rather than registry policies precisely because policies drift: StartupBoostEnabled read 1 on
// two guests and 0 on a third for weeks, and nothing noticed.
//
// Half of this file exists to prove a NEGATIVE: that moving Edge's launch flags into a preset changed
// nothing about Edge. This repo's corpus is 2,122 captures taken with the old list, and "it still looks
// right" is the standard of proof that let a dead remedy pass three green capture-checks — so the Edge
// command line is asserted in full, in order, against a literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_BROWSER_IMAGES, BROWSERS, DEFAULT_BROWSER, MAGNIFY_FEATURE, SHARED_SUPPRESSED_FEATURES,
  browserArgs, browserFor, browserProfileDir, configuredBrowser, resolveBrowser,
} from "./browsers.mjs";

const URL_UNDER_TEST = "http://pages/case/good";

/** Run `body` with `process.env` patched, restoring whatever was there. */
function withEnv(patch: Record<string, string | undefined>, body: () => void) {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  Object.assign(process.env, patch);
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete process.env[k];
  try {
    body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const argsFor = (id: keyof typeof BROWSERS, url = URL_UNDER_TEST) => browserArgs(BROWSERS[id], url);
const features = (id: keyof typeof BROWSERS) =>
  argsFor(id).find((a) => a.startsWith("--disable-features="))!;

test("Edge's command line is EXACTLY what the corpus was captured with", () => {
  // The whole point of the preset move is that Edge is unchanged. A test that checks each flag
  // individually cannot see a flag that was ADDED, and an extra flag is an evidence change: it would make
  // every cached capture describe a browser configured differently from the one that produced it.
  withEnv({ LOCALAPPDATA: "C:\\Users\\w\\AppData\\Local", A11Y_EDGE_PROFILE: undefined, A11Y_BROWSER_PROFILE: undefined }, () => {
    assert.deepEqual(argsFor("edge"), [
      "--no-first-run", "--no-default-browser-check", "--start-maximized",
      "--disable-session-crashed-bubble",
      "--disable-features=msEdgeWelcomePage,AutofillServerCommunication,"
      + "AutofillAddressProfileSavePrompt,AutofillEnableAccountWalletStorage,msEdgeImageMagnifyUI",
      "--disable-sync", "--disable-background-networking", "--disable-save-password-bubble",
      "--user-data-dir=C:\\Users\\w\\AppData\\Local\\a11y-witness\\edge-profile",
      "--app=http://pages/case/good",
    ]);
  });
});

test("autofill is suppressed in EVERY browser, because probeForms teaches the profile", () => {
  // probeForms SUBMITS forms; the browser then offers to remember the values, and later pages get a
  // suggestion icon inside recognised inputs which NVDA announces as an embedded object. The rate rose
  // from 3% to 31% across the corpus as the profile learned. Chromium's autofill is Chromium's, not
  // Edge's — a Chrome preset that dropped these would reproduce the fault from scratch.
  for (const id of Object.keys(BROWSERS) as (keyof typeof BROWSERS)[]) {
    for (const feature of SHARED_SUPPRESSED_FEATURES) {
      assert.match(features(id), new RegExp(feature), `${id} must suppress ${feature}`);
    }
  }
});

test("there is exactly ONE --disable-features flag per browser", () => {
  // Chromium takes the LAST --disable-features and ignores earlier ones. Adding a second flag rather
  // than extending the list silently disables only half of what you asked for.
  for (const id of Object.keys(BROWSERS) as (keyof typeof BROWSERS)[]) {
    assert.equal(argsFor(id).filter((a) => a.startsWith("--disable-features=")).length, 1, id);
  }
});

test("the welcome page stays suppressed alongside the new features", () => {
  // The regression the single-flag rule protects: msEdgeWelcomePage was there first, and losing it
  // resurfaces the "Welcome to Microsoft Edge" phantom captures.
  assert.match(features("edge"), /msEdgeWelcomePage/);
});

test("Edge's image magnifier is suppressed", () => {
  // Magnify opens a full-window overlay on Ctrl pressed twice while the pointer is over an image, and
  // guidepup sends Ctrl before EVERY captured action. On gov.uk the overlay took the foreground and the
  // capture read "Image Magnify, document" instead of the page — so the run reported that it could not
  // read the site at all. Microsoft documents no policy for this, only a per-profile toggle, which is
  // why it is a flag: `pointer.mjs` is the second, independent guard.
  assert.match(features("edge"), new RegExp(MAGNIFY_FEATURE));
});

test("Edge-only feature names do not leak into Chrome", () => {
  // Chromium ignores an unrecognised --disable-features name in complete silence, so this costs nothing
  // at runtime and would never show up as a failure. It is asserted because a preset that quietly carries
  // another browser's vocabulary is a preset nobody can read to find out what Chrome is actually told.
  for (const edgeOnly of ["msEdgeWelcomePage", MAGNIFY_FEATURE]) {
    assert.doesNotMatch(features("chrome"), new RegExp(edgeOnly));
  }
});

test("Chrome's first-run choice screen is suppressed", () => {
  // Chrome's analogue of msEdgeWelcomePage, and worse: since Chrome 127 the search-engine choice screen
  // is a MODAL, and a modal on the guest desktop blocks input for every subsequent capture while /health
  // keeps answering — the fault class this project has spent the most time misdiagnosing.
  assert.ok(argsFor("chrome").includes("--disable-search-engine-choice-screen"));
});

test("--app is still used, and still carries the URL", () => {
  // --app is what makes the window chromeless. Without it NVDA's quick-nav wanders out of the document
  // into browser UI, which is the original cause of captures reading the browser's own chrome.
  for (const id of Object.keys(BROWSERS) as (keyof typeof BROWSERS)[]) {
    assert.ok(argsFor(id).includes(`--app=${URL_UNDER_TEST}`), id);
  }
});

test("first-run and crash bubbles stay suppressed", () => {
  for (const id of Object.keys(BROWSERS) as (keyof typeof BROWSERS)[]) {
    for (const flag of ["--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble"]) {
      assert.ok(argsFor(id).includes(flag), `${flag} is load-bearing for a clean first line in ${id}`);
    }
  }
});

test("each browser gets its OWN profile directory", () => {
  // Chromium refuses to run two builds against one --user-data-dir, and the quieter half is worse: a
  // profile Edge warmed carries Edge's learned autofill into a Chrome capture, so the two browsers would
  // differ for a reason that has nothing to do with the browser.
  withEnv({ LOCALAPPDATA: "C:\\L", A11Y_EDGE_PROFILE: undefined, A11Y_BROWSER_PROFILE: undefined }, () => {
    const dirs = Object.values(BROWSERS).map((b) => browserProfileDir(b));
    assert.equal(new Set(dirs).size, dirs.length, `profile directories collide: ${dirs.join(", ")}`);
  });
});

test("A11Y_EDGE_PROFILE still overrides, and only for Edge", () => {
  // provision-nvda-worker.ps1 reads this variable to decide which directory to prepare. If the worker
  // stopped honouring it, provisioning would warm one profile while captures used another — and an
  // unprepared profile is a first-run browser, which is the phantom-element fault above.
  withEnv({ LOCALAPPDATA: "C:\\L", A11Y_EDGE_PROFILE: "D:\\edge", A11Y_BROWSER_PROFILE: undefined }, () => {
    assert.equal(browserProfileDir(BROWSERS.edge), "D:\\edge");
    assert.equal(browserProfileDir(BROWSERS.chrome), "C:\\L\\a11y-witness\\chrome-profile");
  });
});

test("an unknown browser is refused, not guessed at", () => {
  // The id reaches `taskkill /im <image>` through `cmd`. An allow-list makes an injection structurally
  // impossible rather than carefully avoided, and a typo a 400 rather than a capture in the wrong browser.
  for (const bad of ["firefox", "msedge.exe", "", "chrome; calc.exe"]) {
    assert.throws(() => resolveBrowser(bad), /unknown browser/, JSON.stringify(bad));
  }
  assert.equal(resolveBrowser("CHROME").id, "chrome", "case and padding are tolerated, unknown names are not");
  assert.equal(resolveBrowser(" edge ").id, "edge");
});

test("the default browser is Edge, because that is what every capture on disk used", () => {
  // Changing this silently re-labels the corpus. A guest without Edge must fail loudly instead.
  assert.equal(DEFAULT_BROWSER, "edge");
  withEnv({ A11Y_BROWSER: undefined }, () => assert.equal(browserFor().id, "edge"));
});

test("the request wins over the guest's setting, which wins over the default", () => {
  // Per-request is the whole point: comparing Edge against Chrome must be one run against one guest with
  // one NVDA, or the difference measured is the guest, not the browser.
  withEnv({ A11Y_BROWSER: "chrome" }, () => {
    assert.equal(browserFor().id, "chrome");
    assert.equal(browserFor({ browser: "edge" }).id, "edge");
    assert.equal(browserFor({}).id, "chrome");
  });
});

test("a typo in A11Y_BROWSER does not stop the worker booting", () => {
  // `server.mjs` and `capture-core.mjs` both read this at MODULE LOAD. Throwing there means the process
  // never binds its port — no /health, no /diagnostics, nothing to read — which is indistinguishable from
  // a dead machine, and this project has already spent two days on that misdiagnosis once. So a bad guest
  // setting falls back and REPORTS. Asserted rather than assumed, because the failure it prevents is
  // invisible until the worst possible moment.
  withEnv({ A11Y_BROWSER: "chorme" }, () => {
    const { app, error } = configuredBrowser();
    assert.equal(app.id, DEFAULT_BROWSER);
    assert.match(String(error), /A11Y_BROWSER.*unknown browser/);
    assert.equal(browserFor().id, DEFAULT_BROWSER, "browserFor must not throw on the guest's own setting");
  });
});

test("a valid A11Y_BROWSER reports no error", () => {
  // The other half of the guard: it must be able to say "fine", or /health would report a fault on every
  // correctly configured Chrome guest and `ready` would be false forever.
  withEnv({ A11Y_BROWSER: "chrome" }, () => {
    assert.deepEqual(configuredBrowser().error, null);
    assert.equal(configuredBrowser().app.id, "chrome");
  });
  withEnv({ A11Y_BROWSER: undefined }, () => assert.equal(configuredBrowser().error, null));
});

test("a bad value in a REQUEST still throws, unlike the guest's setting", () => {
  // The asymmetry is the point: a request's mistake belongs in the caller's 400, where they can see it.
  // Falling back for a request would silently capture in a browser nobody asked for and label the evidence
  // with it — a lie the tool tells about itself, in the cache key.
  withEnv({ A11Y_BROWSER: "edge" }, () => {
    assert.throws(() => browserFor({ browser: "chorme" }), /unknown browser/);
  });
});

test("Edge's name is the string the capture cache already keys on", () => {
  // `environmentKey()` puts `browser` in the cache key. Every cached capture carries "Microsoft Edge";
  // renaming this to something tidier would invalidate 2,122 captures for a cosmetic change.
  assert.equal(BROWSERS.edge.name, "Microsoft Edge");
  const names = Object.values(BROWSERS).map((b) => b.name);
  assert.equal(new Set(names).size, names.length, "two browsers sharing a name would share a cache key");
});

test("every preset names an executable that could exist", () => {
  // A preset whose `exes()` returns nothing makes `browserAvailable()` false forever, which reads as a
  // broken guest rather than a broken preset.
  withEnv({ ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\L" }, () => {
    for (const browser of Object.values(BROWSERS)) {
      const paths = browser.exes();
      assert.ok(paths.length > 0, `${browser.id} lists no executable paths`);
      for (const path of paths) {
        assert.ok(path.endsWith(browser.image), `${browser.id}: ${path} is not a ${browser.image}`);
        assert.doesNotMatch(path, /^\\|undefined/, `${browser.id}: ${path} came from an unset variable`);
      }
    }
  });
});

test("ALL_BROWSER_IMAGES covers every preset", () => {
  // diagnostics counts strays by this list. A preset missing from it is a browser that can leak processes
  // onto a guest and never appear in /diagnostics — invisible exactly when somebody is looking for it.
  assert.deepEqual([...ALL_BROWSER_IMAGES].sort(), Object.values(BROWSERS).map((b) => b.image).sort());
});
