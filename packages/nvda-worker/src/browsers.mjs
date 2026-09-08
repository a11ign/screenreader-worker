// @ts-check
import { errorText } from "./error-text.mjs";

/**
 * Which browser a capture drives — as DATA, in one place.
 *
 * The browser was spread across eight sites: an exe search list in `capture-core.mjs`, a launch-flag
 * builder and a profile path in `capture-pure.mjs`, two `"msedge.exe"` string literals in the close path,
 * a `windowsActivate("msedge.exe", "Edge")` call, a `cmd /c start msedge` fallback, a watched-process
 * name in `diagnostics.mjs`, and an orphan-killer in `browser-profile.mjs`. Adding a second browser by
 * editing eight sites is the shape this repo has paid for repeatedly — *a fix applied at ONE call site
 * when the behaviour reaches several* — except run forwards: a preset applied at seven sites and missed
 * at the eighth is a capture that launches Chrome and kills Edge.
 *
 * Plain objects and lookups, deliberately. `CLAUDE.md` forbids importing the Java-OO machinery ("Abstract
 * Factory to hide switches, class-per-noun") into this functional pipeline, and there is nothing here that
 * a record and a function do not express.
 *
 * ## Why the browser is EVIDENCE, not configuration
 *
 * `environmentKey()` already keys the capture cache on `browser`/`browserVersion`, for the same reason it
 * keys on `os` and `architecture`: *"a fleet can have more than one image"*. That value has been the
 * literal string `"Microsoft Edge"` since it was written, so the key has been carrying a constant. The
 * moment one guest runs Chrome the constant becomes a lie and two browsers' evidence blends into one
 * corpus indistinguishably — the exact failure the `os` key exists to prevent. So the preset's `name`
 * feeds `runtimeEnvironment()`, and the cache key starts doing the job it was already written for. No
 * change to the key's shape is needed; it was right in advance.
 *
 * Keeping Edge's `name` as `"Microsoft Edge"` is therefore load-bearing: it is what makes every one of the
 * 2,122 cached Edge captures still valid. A tidier `"edge"` would have invalidated the lot for a rename.
 *
 * ## What is verified and what is predicted
 *
 * The Edge preset is the code that produced this repo's entire corpus, moved without alteration — the flag
 * list is byte-identical, in the same order, and the profile path resolves to the same directory a
 * provisioned guest already has warmed.
 *
 * **The Chrome preset has never taken a capture.** There is no Chrome guest yet. It is assembled from the
 * Chromium switches Edge shares, plus the two Chrome-only surfaces that correspond to faults Edge already
 * caused here. Treat every Chrome line as a hypothesis until `evidence:check` has compared the two, which
 * is the point of building it: *does NVDA announce the same thing in Edge and Chrome, given both are
 * Chromium?* Nobody has published that, and this makes it a one-command question.
 */

/**
 * Chromium-level features suppressed in every browser, because each one changes what NVDA HEARS.
 *
 * These are not preferences. Autofill draws a suggestion icon inside recognised inputs and NVDA announces
 * it as an embedded object — `"Recipient name, edit, ￼"` — and because `probeForms` submits forms, the
 * profile LEARNS and the rate climbs as a run proceeds: measured 3%, then 8%, then 31% of affected
 * captures, with 26 good/bad pairs disagreeing about it. A pair differing by the measuring tool is the one
 * defect this project cannot tolerate.
 *
 * These are command-line flags rather than browser policies ON PURPOSE. The equivalent registry policies
 * were set by provisioning and had already drifted: `StartupBoostEnabled` read 1 on two guests and 0 on a
 * third, and nothing noticed for weeks. A flag lives in git, is applied at every launch, and cannot differ
 * between guests. That argument gets stronger with a second browser, not weaker — Chrome's policies live
 * under a different registry key entirely, so a policy-based approach would need a second provisioning
 * path to drift in.
 */
export const SHARED_SUPPRESSED_FEATURES = [
  "AutofillServerCommunication", // no server-side suggestions
  "AutofillAddressProfileSavePrompt", // never offer to remember a submitted form
  "AutofillEnableAccountWalletStorage",
];

/**
 * Edge's image magnifier, suppressed because guidepup sends Ctrl before EVERY captured action.
 *
 * Magnify opens a full-window overlay on Ctrl pressed twice while the pointer is over an image. On gov.uk
 * the overlay took the foreground and the capture read `"Image Magnify, document"` instead of the page, so
 * the run reported that it could not read the site at all.
 *
 * **`pointer.mjs` is the fix. This flag is an UNVERIFIED belt beside that brace.** With the pointer parked
 * at (0,0) no image is ever under it, so the shortcut cannot fire at all — measured: gov.uk went from
 * three failed attempts and a refusal to a clean 108-announcement capture on the first try. The flag only
 * matters if the park itself fails, which the capture records as `pointerParkFailed`. The park is
 * browser-agnostic, so Chrome inherits the real remedy even though it has no such feature to disable.
 *
 * The name is a GUESS, from Microsoft's documented *enable* flag `--enable-features=msEdgeImageMagnifyUI`;
 * there is no policy for this feature, only a per-profile settings toggle. An unrecognised
 * `--disable-features` name is ignored in complete silence, so it is kept for its non-zero chance of being
 * right at zero runtime cost — not because it is known to work. `pointer.mjs` is the second, independent
 * guard.
 *
 * **Do not try to verify it through CDP `SystemInfo.getFeatureState`.** That was built here and removed: it
 * answers `"Unknown feature"` for `msEdgeImageMagnifyUI`, for `msEdgeWelcomePage` AND for
 * `AutofillServerCommunication` — the last of which demonstrably works, since suppressing it took the
 * U+FFFC artefact from 3-31% of affected captures to 0 of 15. The method cannot see the features we set,
 * so it cannot distinguish "wrong name" from "not queryable", and a diagnostic reporting a working flag as
 * unknown is worse than none. The only real test is behavioural: park the pointer ON an image with
 * `A11Y_POINTER_AT` and see whether the overlay appears.
 */
export const MAGNIFY_FEATURE = "msEdgeImageMagnifyUI";

/**
 * Where the browser writes its profile.
 *
 * Under LOCALAPPDATA rather than TEMP because `windows-trim.ps1` empties TEMP — it silently wiped the NVDA
 * install the same way — and a purged profile reverts the browser to its first-run state, whose
 * welcome/sign-in surface NVDA records as phantom elements on pages with no headings.
 *
 * **Per browser, never shared.** Chromium refuses to run two builds against one `--user-data-dir`, and the
 * quieter half of that is worse: a profile Edge warmed carries Edge's learned autofill entries into a
 * Chrome capture, so the two browsers' evidence would differ for a reason that has nothing to do with the
 * browser. Same rule as the cache key, one level down.
 *
 * `A11Y_EDGE_PROFILE` is still honoured for Edge and only for Edge. `provision-nvda-worker.ps1` reads it
 * to decide which directory to prepare, so dropping it would leave provisioning preparing one path while
 * the worker used another — and an unprepared profile is a first-run browser, which is the phantom-element
 * fault above. `A11Y_BROWSER_PROFILE` is the browser-agnostic override for anything new.
 *
 * @param {BrowserPreset} browser
 */
export function browserProfileDir(browser) {
  const override = process.env.A11Y_BROWSER_PROFILE ||
    (browser.id === "edge" ? process.env.A11Y_EDGE_PROFILE : "");
  if (override) return override;
  const root = process.env.LOCALAPPDATA || process.env.TEMP;
  return `${root}\\a11y-witness\\${browser.profileName}`;
}

/**
 * The switches every Chromium browser gets, given a resolved profile directory.
 *
 * `--app` opens a single chromeless window (no tab strip, address bar, toolbar or banners) showing ONLY
 * this URL, so NVDA's browse-mode quick-nav cannot wander out of our document into browser UI — the Root-1
 * cause of captures that read the image-viewer and "Close banner" instead of the page.
 *
 * Chromium honours only the **last** `--disable-features`, so every feature name must go in this one list;
 * a second flag silently disables only half of what you asked for.
 */
/**
 * `BrowserPreset`, not a hand-written subset. The preset is declared once above and a second, narrower
 * spelling here failed immediately on `suppressedFeatures` and `extraArgs` — the same defect as the
 * wrapper in `everything-pipeline.mjs` an hour earlier: a type that restates its subject has two copies
 * of it, and one of them will be wrong.
 *
 * @param {BrowserPreset} browser
 * @param {string} url
 * @param {string} profileDir
 */
function chromiumArgs(browser, url, profileDir) {
  return [
    "--no-first-run", "--no-default-browser-check", "--start-maximized",
    "--disable-session-crashed-bubble",
    `--disable-features=${browser.suppressedFeatures.join(",")}`,
    // Belt and braces alongside the feature flags: these are long-standing switches rather than feature
    // names, so they do not depend on a feature surviving a Chromium rename.
    "--disable-sync", "--disable-background-networking", "--disable-save-password-bubble",
    ...browser.extraArgs,
    `--user-data-dir=${profileDir}`, `--app=${url}`,
  ];
}

/**
 * The browsers a capture can drive.
 *
 * `windowTitle` is passed to guidepup's `windowsActivate`, which uses it as a **regex** over
 * `MainWindowTitle`. It is a poor matcher for both browsers — an `--app` window is titled with the PAGE
 * title, which rarely contains "Edge" or "Chrome" — which is exactly why `focusExistingBrowserWindow` is
 * the fast path. That one needs no preset at all: it matches the window CLASS, and Chromium names its
 * top-level windows `Chrome_WidgetWin_1` whatever the branding, so the code that already focuses Edge
 * focuses Chrome unchanged.
 */
/**
 * @typedef {object} BrowserPreset
 * @property {string} id             allow-list key; the only value a request may name
 * @property {string} name           product name, and the capture cache's word for this browser
 * @property {string} image          process image, for activate / quit / taskkill / stray counting
 * @property {string} windowTitle    regex guidepup matches against MainWindowTitle
 * @property {string} profileName    directory under %LOCALAPPDATA%\\a11y-witness
 * @property {string[]} suppressedFeatures  goes in the single --disable-features list
 * @property {string[]} extraArgs    switches this browser needs and the others do not
 * @property {() => string[]} exes   install locations, in search order
 */

/** @type {Record<string, BrowserPreset>} */
export const BROWSERS = {
  edge: {
    id: "edge",
    // Feeds `runtimeEnvironment().browser` and therefore the capture cache key. Changing this string
    // invalidates every cached Edge capture; it is the corpus's name for its own browser.
    name: "Microsoft Edge",
    image: "msedge.exe",
    windowTitle: "Edge",
    profileName: "edge-profile",
    // `msEdgeWelcomePage` first and the magnifier last, preserving the order this repo's corpus was
    // captured with. Chromium treats the list as a set, so the order cannot matter to the browser — it
    // matters to the claim that moving this code changed nothing.
    suppressedFeatures: ["msEdgeWelcomePage", ...SHARED_SUPPRESSED_FEATURES, MAGNIFY_FEATURE],
    extraArgs: [],
    // Resolved so we can spawn the browser directly and OWN the process: launching via `cmd /c start`
    // returns no handle, which means teardown can only be guessed at. See `closeBrowser`.
    exes: () => [
      `${process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles || "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
  },
  chrome: {
    id: "chrome",
    name: "Google Chrome",
    image: "chrome.exe",
    windowTitle: "Chrome",
    profileName: "chrome-profile",
    suppressedFeatures: [...SHARED_SUPPRESSED_FEATURES],
    // Chrome's analogue of `msEdgeWelcomePage`, and the reason it is a switch rather than a feature name:
    // Google ships it as a documented command-line switch. Since Chrome 127 a search-engine choice dialog
    // can appear on first run, and a modal on the guest desktop is the fault class that costs this project
    // the most — `/health` keeps answering while every capture drives NVDA into a desktop that cannot
    // receive input. Predicted, not yet observed here; there is no Chrome guest.
    extraArgs: ["--disable-search-engine-choice-screen"],
    // Chrome installs per-machine OR per-user, and the per-user location is the common case on a box
    // somebody set up by hand. Edge has no equivalent, which is why its list is shorter — omitting
    // LOCALAPPDATA would make `browserAvailable()` report "no browser" on a perfectly working install.
    exes: () => [
      `${process.env.ProgramFiles || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  },
};

/**
 * Edge, because that is what every capture on disk used.
 *
 * A guest with no Edge — a tiny11 image, which deletes it — must say so out loud rather than quietly
 * capturing in whatever browser it happens to have. `browserAvailable()` returning false names the
 * expected browser and the paths it looked in; a silent fallback would put two browsers' evidence in one
 * corpus, which is the failure the cache key exists to prevent, arriving by a different door.
 */
export const DEFAULT_BROWSER = "edge";

/**
 * Look up a preset by id, or fail loudly.
 *
 * Validation is not ceremony here. The id reaches `taskkill /im <image>` through `cmd`, and an unvalidated
 * string arriving over HTTP would be an injection into a shell command that force-kills processes. An
 * allow-list makes that structurally impossible rather than carefully avoided.
 *
 * @param {string} [id]
 * @returns {BrowserPreset}
 */
export function resolveBrowser(id) {
  const key = String(id ?? DEFAULT_BROWSER).trim().toLowerCase();
  const browser = BROWSERS[key];
  if (!browser) {
    throw new Error(`unknown browser ${JSON.stringify(id)}; expected one of ${Object.keys(BROWSERS).join(", ")}`);
  }
  return browser;
}

/**
 * What this GUEST is configured for — and it NEVER throws.
 *
 * The asymmetry with `resolveBrowser` is deliberate, and it is about who can see the failure. A bad value
 * in a request is the caller's mistake and belongs in their 400. A bad `A11Y_BROWSER` in the guest's
 * scheduled task is read at module load by `server.mjs` and `capture-core.mjs`, where throwing means the
 * worker never binds its port — no `/health`, no diagnostics, nothing to read. That is indistinguishable
 * from a dead machine, which this project has already misdiagnosed for two days once, and it would be
 * caused by a typo in an environment variable.
 *
 * So a misconfigured guest falls back to the default and REPORTS, which `/health` surfaces and `doctor`
 * can act on. Loud, but still answering.
 *
 * @returns {{ app: BrowserPreset, error: string | null }}
 */
export function configuredBrowser() {
  const configured = process.env.A11Y_BROWSER;
  if (!configured) return { app: BROWSERS[DEFAULT_BROWSER], error: null };
  try {
    return { app: resolveBrowser(configured), error: null };
  } catch (error) {
    return { app: BROWSERS[DEFAULT_BROWSER], error: `A11Y_BROWSER: ${errorText(error)}` };
  }
}

/**
 * Which browser this capture drives: the request's choice, else the guest's, else Edge.
 *
 * Per-request is what makes the Edge-vs-Chrome comparison a single run rather than a redeploy — the same
 * page, the same NVDA, the same guest, one variable. `A11Y_BROWSER` is how a guest that HAS only one
 * browser declares it, set once in `run-server.cmd`.
 *
 * A request's value is validated STRICTLY (an unknown name throws, and the server answers 400); the
 * guest's own setting is not, for the reason in `configuredBrowser`.
 *
 * @param {{ browser?: string }} [request]
 * @returns {BrowserPreset}
 */
export function browserFor(request) {
  return request?.browser ? resolveBrowser(request.browser) : configuredBrowser().app;
}

/**
 * The full launch command line for a URL.
 *
 * @param {BrowserPreset} browser
 * @param {string} url
 */
export function browserArgs(browser, url) {
  return chromiumArgs(browser, url, browserProfileDir(browser));
}

/** Every image name a worker might have to kill or count, whichever browser it is configured for. */
export const ALL_BROWSER_IMAGES = Object.values(BROWSERS).map((b) => b.image);
