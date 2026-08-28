// @ts-check
/**
 * Keep one Edge alive across captures and re-point it, instead of cold-starting Chromium every time.
 *
 * ## Why
 *
 * `windowsActivate` — which is really "wait for Edge to exist and take focus" — is the largest single
 * phase of a capture, and it is Chromium's cold start. Measured on this fleet:
 *
 *   one guest running     windowsActivate  8.9 s of a 12.6 s capture
 *   three guests running  windowsActivate ~15.2 s on ALL THREE, uniformly
 *
 * That uniform inflation is the signature of a SHARED resource, and it is not RAM: guest residency is
 * 0.9-1.6 GB and cold pages compress fine. Three guests cold-starting Chromium contend on one SSD. The
 * consequence measured end to end is that the pool does not scale at all — 1 worker gives 0.079
 * captures/s, 2 give 0.076, 3 give 0.072. **Adding workers made throughput worse.** Removing the cold
 * start attacks the per-capture cost and the contention that caps the pool, in one change.
 *
 * ## Why the DevTools Protocol rather than reusing the window
 *
 * Captures run `--app`, which is a chromeless window with no address bar, so there is no UI route to
 * navigate an existing window — and abandoning `--app` resurfaces the browser chrome that NVDA used to
 * wander into (the "Welcome to Microsoft Edge" phantoms). Opening a second `--app` window per capture
 * and closing it again would work, but closing the LAST window exits the process, so it needs a keeper
 * window and Alt+F4 aimed at the right target. That is window-focus juggling, which this project's own
 * notes call the #1 flakiness fix — not somewhere to be clever.
 *
 * `Page.navigate` re-points the window that already exists. No new window, no focus transition, no
 * process start.
 *
 * ## ON by default
 *
 * A reused browser is a different evidence-production environment from a fresh one: a persistent
 * renderer keeps session state, and a page loaded by navigation may announce differently from one loaded
 * into a new window. That is exactly what `npm run evidence:check` exists to answer, and it has — so the
 * gate is passed and this is the normal path, disabled with `A11Y_REUSE_BROWSER=0`.
 *
 * Worth knowing before reading `edgeArgs`: the DevTools port is added by `reusableArgs`, not by the
 * one-shot launch, so CDP is available exactly because reuse is the default. The census and
 * `currentPageUrl` depend on it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Chromium's DevTools endpoint. Loopback only — it is never reachable off the guest. */
export const CDP_PORT = 9222;
const AX_TREE_TIMEOUT_MS = 5_000;
const CDP_HOST = "127.0.0.1";

/**
 * How long Edge gets to open its DevTools port.
 *
 * Was 20 s, which is generous for a dataset page and far too tight for a real one: launching with `--app=URL`
 * starts LOADING the page, so on a heavy site on a 3 GB guest the port opened well past 20 s and the reusable
 * launch was declared failed — after which the fallback relaunched Edge and paid the cost twice, inside a
 * 280 s capture budget. Raised deliberately, and it is still a bound: an Edge that has not answered in a
 * minute is broken, not busy.
 */
const CDP_READY_TIMEOUT_MS = 60_000;
const CDP_POLL_MS = 200;
const NAVIGATE_TIMEOUT_MS = 30_000;

const endpoint = (/** @type {string} */ path) => `http://${CDP_HOST}:${CDP_PORT}${path}`;

/**
 * Arguments for a reusable Edge.
 *
 * Identical to the one-shot launch except for the debugging port, deliberately: every other flag is
 * load-bearing for what NVDA hears, and changing any of them would confound an evidence comparison.
 *
 * @param {string} url
 * @param {string[]} baseArgs the flags the one-shot launch already uses
 */
export function reusableArgs(url, baseArgs) {
  return [...baseArgs, `--remote-debugging-port=${CDP_PORT}`];
}

/** Is a reusable browser answering on the DevTools port? */
export async function browserAlive() {
  try {
    const response = await fetch(endpoint("/json/version"), { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false; // not running, or not listening yet — both mean "launch one"
  }
}

/**
 * The page target to drive.
 *
 * Pure so the selection rule is testable. Chromium lists more than pages — service workers, extension
 * backgrounds, the DevTools UI itself — and picking the wrong one produces a navigate that silently
 * does nothing to the visible window.
 *
 * @param {Array<{type?: string, url?: string, webSocketDebuggerUrl?: string}>} targets
 */
/**
 * @typedef {{ type?: string, url?: string, webSocketDebuggerUrl?: string }} CdpTarget
 * @typedef {CdpTarget & { webSocketDebuggerUrl: string }} UsablePageTarget
 *
 * The `find` below already REQUIRES `typeof webSocketDebuggerUrl === "string"`, so a returned target
 * always has one -- but a predicate inside `find` cannot narrow the result, and every caller then reads a
 * possibly-undefined URL straight into `new WebSocket`. The second typedef states what the filter has
 * already established rather than re-checking it at four call sites.
 *
 * @param {CdpTarget[] | null | undefined} targets
 * @returns {UsablePageTarget | null}
 */
export function choosePageTarget(targets) {
  return /** @type {UsablePageTarget | undefined} */ ((targets ?? []).find((t) =>
    t.type === "page" && typeof t.webSocketDebuggerUrl === "string" && !t.url?.startsWith("devtools://")
  )) ?? null;
}

/**
 * How long Edge gets to list its targets, and how many tries.
 *
 * Was a single attempt at 5 s, and that lost the STRUCTURAL CENSUS on the one page that most needed it: 150 s
 * into a capture of a real site, with Edge busy, `/json/list` did not answer in time and the census came back
 * `null` with "fetch failed". The census is the AX tree's own count of links, graphics and controls — the
 * ground truth against which a sweep's coverage can be stated as a number rather than as the word
 * "INCOMPLETE". Losing it exactly when the page is large is losing it exactly when it matters.
 *
 * Retried because a busy Chromium answers late, not never — and still bounded, because this sits inside a
 * capture budget.
 */
const CDP_LIST_TIMEOUT_MS = 15_000;
const CDP_LIST_ATTEMPTS = 3;
const CDP_LIST_RETRY_MS = 750;

/** @returns {Promise<UsablePageTarget>} */
async function pageTarget() {
  let last;
  for (let attempt = 1; attempt <= CDP_LIST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(endpoint("/json/list"), {
        signal: AbortSignal.timeout(CDP_LIST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
      const target = choosePageTarget(await response.json());
      if (!target) throw new Error("CDP listed no page target to navigate");
      return target;
    } catch (error) {
      last = error;
      if (attempt < CDP_LIST_ATTEMPTS) await new Promise((r) => setTimeout(r, CDP_LIST_RETRY_MS));
    }
  }
  // Rethrow with the cause, so a caller sees WHY rather than a bare "fetch failed" after three silent tries.
  throw new Error(`CDP /json/list did not answer in ${CDP_LIST_ATTEMPTS} attempts`, { cause: last });
}

/**
 * Point the existing window at a new URL and wait for the load event.
 *
 * Waiting for `Page.loadEventFired` rather than returning on the navigate acknowledgement matters: the
 * caller's next move is to ask NVDA to read the document, and reading a page that has not finished
 * loading is precisely the "blank, blank" transcript this pipeline already learned to avoid.
 */
/** @param {string} url */
export async function navigateExisting(url) {
  const target = await pageTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await once(socket, "open", CDP_READY_TIMEOUT_MS);
    const loaded = waitForMethod(socket, "Page.loadEventFired", NAVIGATE_TIMEOUT_MS);
    socket.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    socket.send(JSON.stringify({ id: 2, method: "Page.navigate", params: { url } }));
    await loaded;
  } finally {
    try {
      socket.close();
    } catch (error) {
      // A socket that will not close is not a failed capture; the navigate already happened.
      void error;
    }
  }
}

/**
 * Landmark roles, per ARIA. `region` is deliberately conditional -- see `censusFromAXTree`.
 */
const LANDMARK_ROLES = ["main", "navigation", "banner", "contentinfo", "complementary", "search", "form", "region"];

/**
 * Role -> which sweep it belongs to. A lookup rather than a branch chain: the chain put this function
 * over the complexity gate, and naming the mapping once is clearer than restating it in `else if`s.
 */
/** @type {Map<string, string>} */
const ROLE_BUCKET = new Map([
  ["heading", "heading"], ["link", "link"],
  ["image", "graphic"], ["img", "graphic"], ["graphics-document", "graphic"],
  .../** @type {[string, string][]} */ (LANDMARK_ROLES.map((role) => [role, "landmark"])),
]);

/**
 * How many structural elements does the PAGE actually expose?
 *
 * This is a completeness ORACLE, never evidence. The distinction is the whole design: what a screen
 * reader announced is the evidence, and `docs/local-model.md` forbids the accessibility tree as a model
 * feature. But a sweep that under-reports is indistinguishable from a page that has nothing -- and that
 * is exactly the defect this exists to catch. `structure.landmarks` misses a `<main>` wrapping the page
 * on 2,063 of 2,064 corpus captures, because quick navigation cannot reach a landmark containing the
 * caret, and nothing could see it.
 *
 * Asking Chromium costs one CDP call on a socket that is already open: milliseconds, no keystrokes, no
 * modal dialog. The alternative -- reading NVDA's own Elements List -- is authoritative but costs ~11s
 * per capture for landmarks alone, because every keystroke waits on guidepup's 1s speech-quiet
 * debounce. At 2,122 captures that is the difference between a verification you run always and one you
 * can never afford.
 *
 * @param {Array<{role?: {value?: string}, name?: {value?: string}, ignored?: boolean}>} nodes
 *   `Accessibility.getFullAXTree`'s flat node list.
 */
/**
 * Which bucket this node counts toward, and whether it is nameless — or null when it counts toward none.
 *
 * Split out of `censusFromAXTree` because the two jobs are separable: this one classifies a single node,
 * the caller accumulates. It also put the census over the complexity gate, and the honest fix for that is a
 * named function rather than a bigger limit.
 */
/**
 * Is this AX node CSS-generated content rather than an element on the page?
 *
 * `Accessibility.getFullAXTree` gives every DOM-backed node a `backendDOMNodeId`; generated content -- a
 * `<::marker>` bullet, a `::before` with `content:` -- has none, and a negative synthetic `nodeId` instead.
 * Named because the absent field is a CDP implementation detail and "generated content" is the thing being
 * decided; `classifyAXNode` explains WHY it must not be counted.
 */
/** @param {Record<string, any>} node */
function isGeneratedContent(node) {
  return node.backendDOMNodeId == null;
}

/** @param {Record<string, any> | null} node */
function classifyAXNode(node) {
  // Ignored nodes are not in the tree a screen reader walks, so counting them would make the oracle demand
  // elements NVDA could never announce -- a guard that cries wolf gets removed, not heeded.
  if (!node || node.ignored) return null;
  const role = String(node.role?.value ?? "").toLowerCase();
  const named = String(node.name?.value ?? "").trim();
  const bucket = ROLE_BUCKET.get(role);
  // An unnamed `region` is NOT a landmark: ARIA requires an accessible name for `role="region"` to be
  // exposed as one, and NVDA agrees -- named regions are announced ("Latest news, region") while a bare
  // `<section>` is not. Counting them would invent landmarks the page does not have.
  if (bucket === "landmark" && role === "region" && !named) return { named, bucket: null };
  // GENERATED content is not page content, and a CSS bullet is the case that proves it. Chromium exposes a
  // `list-style-image` marker as role=image with a NEGATIVE synthetic nodeId, no properties and no
  // `backendDOMNodeId`, parented to the `<::marker>` pseudo-element. Two of those made this oracle report
  // two unnamed graphics on the W3C BAD "after" pages -- which W3C publishes as fully WCAG 2.0 AA
  // conformant -- and `addUnnamedGraphics` turns that count straight into a 1.1.1 accusation.
  //
  // Note what this was NOT: the four decorative `alt=""` images on that page were ignored by Chromium
  // correctly all along, exactly as the comment below says. 6 real images plus 2 bullets is the 8 the
  // census reported, so the count was never about the `alt=""` images at all.
  //
  // Same reasoning as the `ignored` check above: quick navigation cannot visit a bullet, so demanding the
  // sweep find one makes the oracle cry wolf. Measured over four real pages -- unnamed images fell 2 -> 0
  // on `after/home`, 2 -> 0 on `after/survey`, and stayed at ALL 33 on `before/home`, the inaccessible
  // demo, because every real `<img>` carries a `backendDOMNodeId`.
  //
  // If some future Chromium omitted that field for real elements the oracle would UNDER-count, losing a
  // possible finding rather than inventing one. For an accessibility tool that is the correct direction to
  // fail in, and it is the same tradeoff the scorer's abstention makes.
  //
  // Deliberately `bucket: null` rather than `null`: NVDA does announce generated TEXT, and the truncation
  // detector needs every name a capture can produce.
  if (isGeneratedContent(node)) return { named, bucket: null };
  return { named, bucket: bucket ?? null };
}

/**
 * Ask Chromium to bring its own window to the front, over the DevTools Protocol.
 *
 * This is the cheap answer to the phase that has cost the most: `windowsActivate` was ~10 s of a ~25 s capture
 * and did not finish at all on a heavy real website. Every other route goes outside the browser and pays for
 * it — guidepup shells out to `cscript`, which runs a WMI `Win32_Process LIKE '%msedge.exe%'` scan and a nested
 * PowerShell; a hand-rolled `SetForegroundWindow` still needs an `Add-Type` C# compile, which timed out at 15 s
 * on a loaded guest. `Page.bringToFront` asks the process that owns the window, through a socket that is
 * already how this worker drives the browser, and costs one round trip.
 *
 * It is not a complete replacement: it cannot LAUNCH a browser, and Windows can still refuse the foreground,
 * so the callers keep their fallbacks. But it is the right thing to try first, and on the path that matters —
 * a window that already exists — it is the only route that does not enumerate something.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function bringPageToFront() {
  let socket;
  try {
    const target = await pageTarget();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, "open", CDP_READY_TIMEOUT_MS);
    const done = waitForResult(socket, 1, CDP_READY_TIMEOUT_MS);
    socket.send(JSON.stringify({ id: 1, method: "Page.bringToFront" }));
    // A resolved round trip is the confirmation. `waitForResult` rejects on a CDP error frame, so a refusal
    // arrives here as a throw rather than as a quiet success — the distinction this project keeps having to
    // relearn about verifications that share a failure mode with the action.
    await done;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      socket?.close();
    } catch (error) {
      // A socket that will not close is not a failed activation; the request already went.
      void error;
    }
  }
}

/**
 * @param {(Record<string, any> | null)[] | null | undefined} nodes
 *   NULL ENTRIES ARE EXPECTED. `ax-census.test.ts` passes `[null, {}]` deliberately -- 'the oracle must
 *   never be the reason a capture fails' -- so a type refusing them would describe a stricter function
 *   than the one that exists, and than the one the pipeline needs.
 */
export function censusFromAXTree(nodes) {
  // `graphicUnnamed` is the count of images the page exposes with NO accessible name, and it is a finding
  // the announcements cannot reach on their own. Quick navigation skips a wholly nameless graphic: on
  // pages whose images at least have a filename NVDA says "Unlabeled graphic" and the sweep records it,
  // but for an `<img>` with no alt and a `data:` URI there is nothing to say and the sweep walks past.
  // Measured on the eval fixtures — tree 2 graphics / sweep 1, tree 1 / sweep 0, tree 3 / sweep 2 — which
  // is three 1.1.1 failures the layer could see and did not.
  //
  // Safe as a signal because of TWO guards in `classifyAXNode`, and removing either one turns this counter
  // into a false accusation. Ignored nodes are skipped, so Chromium's decorative `alt=""` images never reach
  // it; GENERATED nodes are skipped, so a CSS `list-style-image` bullet does not either -- that one was
  // found by this counter reporting two unnamed graphics on a page W3C publishes as fully AA conformant.
  // What is left is a non-ignored graphic on the page with no name: an image a screen-reader user meets and
  // cannot identify.
  // TYPED, because `names: []` infers `never[]` and every push of a real name is then an error -- and
  // the bucket increment below indexes this object by a role string. The names array is the truncation
  // detector's input, so an empty inferred type would have made the one field added for that unusable.
  /** @type {{ landmark: number, heading: number, link: number, graphic: number,
   *           graphicUnnamed: number, names: string[] } & Record<string, any>} */
  const census = { landmark: 0, heading: 0, link: 0, graphic: 0, graphicUnnamed: 0, names: [] };
  for (const node of nodes ?? []) {
    const classified = classifyAXNode(node);
    if (!classified) continue;
    // Collect the name from EVERY named node, before the role bucketing, because names serve a different
    // purpose from counts. The counts are compared against specific sweeps, so they only cover the roles
    // those sweeps walk; the names exist to catch a TRUNCATED announcement and must therefore cover
    // everything a capture can announce. Restricting them to the bucketed roles left the detector unable to
    // see the case it was built for: a button announced as "o", whose real name was not in the list because
    // `button` is not a bucketed role.
    if (classified.named) census.names.push(classified.named);
    if (!classified.bucket) continue;
    census[classified.bucket] += 1;
    if (classified.bucket === "graphic" && !classified.named) census.graphicUnnamed += 1;
  }
  return census;
}

/**
 * Announcements whose name looks like a TRUNCATED version of a real accessible name.
 *
 * A proper-prefix match is the signature: "o" against "Open account search". Requiring a proper prefix
 * rather than any substring keeps this from firing on the ordinary case where NVDA announces a shortened
 * or differently-punctuated form -- it only fires when what we heard is the START of a real name and
 * stops short, which is exactly what a partial phrase looks like.
 */
/**
 * @param {string[]} spoken
 * @param {string[] | null | undefined} names
 */
export function truncatedAnnouncements(spoken, names) {
  const real = (names ?? []).map((n) => n.toLowerCase());
  const suspect = [];
  for (const phrase of spoken ?? []) {
    // The announced NAME is what precedes the role, e.g. "o, button" -> "o".
    const heard = String(phrase).split(",")[0].trim().toLowerCase();
    if (!heard) continue;
    // An exact match is fine, however short: a control genuinely named "o" is not a truncation.
    if (real.includes(heard)) continue;
    const longer = real.find((n) => n.startsWith(`${heard} `) || n.startsWith(heard) && n.length > heard.length);
    if (longer) suspect.push({ heard: String(phrase), name: longer });
  }
  return suspect;
}

/**
 * Fetch the census from the live page over the already-open DevTools socket.
 *
 * Returns null rather than throwing: this is a diagnostic, and a capture must never fail because an
 * oracle was unavailable. A null census means "not checked", which `crossCheckStructure` treats as
 * unverified rather than as agreement.
 */
export async function structuralCensus() {
  try {
    const target = await pageTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await once(socket, "open", CDP_READY_TIMEOUT_MS);
      const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
      socket.send(JSON.stringify({ id: 1, method: "Accessibility.getFullAXTree" }));
      return censusFromAXTree((await result)?.nodes);
    } finally {
      try { socket.close(); } catch (error) { void error; }
    }
  } catch (error) {
    return { error: /** @type {Error} */ (error).message };
  }
}

/**
 * What the DOM contains, counted in the DOM — not in the accessibility tree.
 *
 * THE ONE MEASUREMENT THIS PROJECT DID NOT HAVE. Both existing structure sources are accessibility-layer:
 * the sweep is what NVDA reached, and `structuralCensus` is what Chromium EXPOSES. `crossCheckStructure`
 * compares those two, so it can catch a sweep that stopped early — and can say nothing whatever about
 * markup the tree never exposed.
 *
 * That gap has a cost and a name. On 2026-08-26 the Met Office warnings page captured as 27 announcements
 * with `census.heading = 0`, while its published HTML carries FORTY headings — and it was IMPOSSIBLE to
 * say whether this tool had failed to render the page or the page was failing to expose it. Those are
 * opposite verdicts: one is our defect, the other is a severe genuine finding of the kind this whole
 * project exists to make. The page had to be removed from the corpus because nobody could attribute it.
 *
 * With a DOM count beside the tree count the question answers itself:
 *
 *     dom.heading 0  tree.heading 0   the page did not render — our problem
 *     dom.heading 40 tree.heading 0   forty headings the tree cannot see — THEIR problem, and a finding
 *
 * ## What is counted, and what is deliberately not
 *
 * Only what the accessibility census also counts, so the two are comparable at all. Counting things the
 * tree has no notion of would produce a difference that means nothing.
 *
 * `alt=""` images are EXCLUDED, because Chromium marks a decorative image as ignored and the tree will
 * not count it either — including them would manufacture a permanent disagreement on correct pages. That
 * is the same reasoning `censusFromAXTree` documents for skipping ignored nodes.
 *
 * `aria-hidden` subtrees are excluded for the same reason: hidden from assistive technology by the
 * author's own instruction, so a tree that omits them is obeying, not failing.
 *
 * Returns null on any failure — this is a diagnostic and a capture must never fail because an oracle was
 * unavailable. Null reads as "not checked", never as "nothing there".
 */
/**
 * The census PROGRAM, as the page will run it.
 *
 * Module-level rather than inside `domCensus` for two reasons. It is the only part of this file that
 * nothing here executes — it is a string handed to another engine — so it deserves to be findable, and
 * `dom-census-expression.test.ts` extracts it by name and runs it against a synthetic DOM, which is the
 * only check it can have. And splitting it kept `domCensus` under the line budget: the page-side program
 * and the CDP round-trip that carries it are two things, which is what the budget was telling me.
 */
const DOM_CENSUS_EXPRESSION = `(() => {
    const visible = (el) => !el.closest("[aria-hidden='true']");
    const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
    // An image with an EMPTY alt is decorative by the author's instruction; Chromium marks it ignored and
    // the AX census does not count it, so counting it here would invent a disagreement on a correct page.
    const graphics = all("img, svg[role='img'], [role='img']")
      .filter((el) => el.getAttribute("alt") !== "");
    // WHICH graphics carry no accessible name, not just how many.
    //
    // \`graphicUnnamed\` was a COUNT, and this repo's own rule is that a count is where an investigation
    // stops rather than starts. Settling whether cqc.org.uk's two unnamed graphics were real meant
    // fetching the page by hand and counting <svg> elements without a <title> — the exact step this
    // removes. Identified DOM-side because an unnamed node has, by definition, no name to identify it by.
    //
    // Presence, not resolution: an element with \`aria-labelledby\` is treated as named without following
    // the reference. Resolving it correctly is the accessibility tree's job and Chromium already did it —
    // this list exists to point a human at an element, not to second-guess the tree.
    const named = (el) => (el.getAttribute("alt") || "").trim()
      || (el.getAttribute("aria-label") || "").trim()
      || el.getAttribute("aria-labelledby")
      || (el.getAttribute("title") || "").trim()
      || (el.querySelector(":scope > title")?.textContent || "").trim();
    const describe = (el) => {
      const src = el.getAttribute("src") || "";
      const file = src ? src.split("?")[0].split("/").pop() : "";
      // Plain split, not a regex: a backslash escape inside this template literal has to be doubled
      // to survive into the page, which ESLint reads as a useless escape in the SOURCE while the page
      // would have received the right thing. Not worth the argument for a diagnostic label — class
      // tokens are space-separated and filter(Boolean) absorbs runs of them.
      //
      // NOTE FOR ANY COMMENT ADDED HERE: this is inside a template literal, so a BACKTICK ends the
      // string. The first version of this comment quoted the call in backticks and broke the file at
      // parse time, which lint reported as "Unexpected token split" ten lines from the real cause.
      const cls = (el.getAttribute("class") || "").trim().split(" ").filter(Boolean)[0];
      return [el.tagName.toLowerCase(), file, cls && \`.\${cls}\`].filter(Boolean).join(" ").slice(0, 80);
    };
    return {
      heading: all("h1, h2, h3, h4, h5, h6, [role='heading']").length,
      link: all("a[href], [role='link']").length,
      graphic: graphics.length,
      // Capped, and the cap SAYS so — a truncated list that reads as complete is the defect one layer on.
      unnamedGraphics: graphics.filter((el) => !named(el)).slice(0, 5).map(describe),
      unnamedGraphicCount: graphics.filter((el) => !named(el)).length,
      landmark: all("main, nav, aside, header, footer, [role='main'], [role='navigation'], "
        + "[role='banner'], [role='contentinfo'], [role='complementary']").length,
      formField: all("input:not([type='hidden']), select, textarea, [role='textbox'], "
        + "[role='combobox']").length,
      // HOW MANY TAB STOPS THE PAGE HAS, which is the only truthful denominator for "did focus reach
      // everything". 2.1.2 corroborates a trap by comparing the tab cycle against the page's controls,
      // and it had only \`structure.formFields\` to compare with — so a dialog holding every FORM FIELD
      // while links sit outside it reads as "focus reached everything" and no trap is reported.
      //
      // Counted here rather than from the sweep because the sweep announces things Tab cannot reach:
      // \`vague-link-inert\` is an anchor with \`tabindex="-1"\`, present in the corpus and walked by NVDA's
      // link quick-nav, so counting swept links would fire this rule on every page carrying one. The DOM
      // knows the difference and the sweep cannot.
      //
      // THE EXCLUSIONS ARE IN JS, NOT IN THE SELECTOR, and that is what makes them checkable. They were
      // \`:not(:disabled)\` and \`:not([tabindex='-1'])\` inside the query, which
      // \`dom-census-expression.test.ts\` cannot evaluate — its harness stubs \`querySelectorAll\` and
      // returns whatever it is handed, so the assertion about an inert anchor passed on a stub that had
      // never applied the filter. Page-side code nothing can execute is the defect that test exists for.
      //
      // \`[tabindex]\` is deliberately broad here and narrowed below: it catches a positive or zero
      // tabindex on anything, and \`-1\` is then removed. Disabled and hidden controls take no focus, and
      // reporting a control the browser skips as one focus failed to reach would be this project's oldest
      // defect — a limit of the page read as a finding about it.
      tabbable: all("a[href], button, input:not([type='hidden']), select, textarea, [tabindex]")
        .filter((el) => el.getAttribute("tabindex") !== "-1"
          && !el.hasAttribute("hidden") && !el.hasAttribute("disabled")).length,
    };
})()`;

export async function domCensus() {
  try {
    const target = await pageTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await once(socket, "open", CDP_READY_TIMEOUT_MS);
      const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: DOM_CENSUS_EXPRESSION, returnByValue: true },
      }));
      const value = (await result)?.result?.value;
      return value && typeof value === "object" ? value : null;
    } finally {
      try { socket.close(); } catch (error) { void error; }
    }
  } catch (error) {
    void error; // a diagnostic probe must never fail a capture; null reads as "not checked"
    return null;
  }
}

/**
 * What URL is the browser showing RIGHT NOW?
 *
 * Needed because a form probe on a real site can NAVIGATE. Submitting Wikipedia's search moved the browser
 * to a different page, and the post-submit field re-read then described that page instead — which
 * `validationErrorIsSilent` read as "a form was submitted and no error was announced", i.e. a 3.3.1
 * failure, on a form that had worked perfectly.
 *
 * Every synthetic page in this corpus calls `preventDefault()`, so submitting never navigated and the
 * distinction never arose. In the wild it is the ordinary case.
 *
 * Returns null rather than throwing: not knowing the URL must degrade the evidence, never fail a capture.
 */
export async function currentPageUrl() {
  try {
    return (await pageTarget()).url ?? null;
  } catch {
    return null;
  }
}

/** Resolve the reply whose `id` matches, as opposed to waitForMethod which waits for an EVENT. */
/**
 * @param {WebSocket} socket @param {number} id @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function waitForResult(socket, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP: no reply to ${id} within ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.error) reject(new Error(`CDP error: ${message.error.message}`));
      else resolve(message.result);
    });
  });
}

/**
 * @param {WebSocket} socket @param {string} event @param {number} timeoutMs
 * @returns {Promise<void>}  the hint `new Promise()` needs for a `resolve()` taking no argument
 */
function once(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP: no '${event}' within ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP socket error")); }, { once: true });
  });
}

/**
 * @param {WebSocket} socket @param {string} method @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForMethod(socket, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP: no ${method} within ${timeoutMs}ms`)), timeoutMs);
    socket.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return; // not our frame
      }
      if (parsed.method === method) { clearTimeout(timer); resolve(); }
    });
  });
}

/**
 * Launch a reusable Edge and wait until its DevTools port answers.
 *
 * @param {{ exe: string, args: string[], onEvent?: (e: object) => void }} options
 */
export async function launchReusable({ exe, args, onEvent = () => {} }) {
  if (!existsSync(exe)) throw new Error(`Edge not found at ${exe}`);
  const child = spawn(exe, args, { stdio: "ignore" });
  child.on("error", (error) => onEvent({ type: "browserError", error: error.message }));
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await browserAlive()) {
      onEvent({ type: "browserReady", pid: child.pid });
      return child;
    }
    await new Promise((r) => setTimeout(r, CDP_POLL_MS));
  }
  throw new Error(`Edge did not open its DevTools port within ${CDP_READY_TIMEOUT_MS}ms`);
}


/**
 * Media elements the page declares, for 1.4.2 Audio Control.
 *
 * The DOM, not the accessibility tree, and that is not a shortcut: `autoplay` and `muted` are HTML
 * attributes with no accessibility-tree equivalent, so no screen reader can report them. This is the only
 * evidence in the pipeline that is not something NVDA said, which its ACT description states plainly.
 *
 * Worth the one extra CDP call because 1.4.2 is a NON-INTERFERENCE criterion under WCAG §5.2.5 — it applies
 * to all content whether or not it is relied upon — and because audio that starts on its own competes with
 * the synthetic speech a screen-reader user is listening to. It masks the interface rather than merely
 * annoying.
 *
 * Returns null rather than throwing, and null means NOT CHECKED. The rule that reads it makes no claim on
 * null, so a probe failure can never become a silent pass.
 */
export async function mediaCensus() {
  const EXPRESSION = `Array.from(document.querySelectorAll("audio,video")).slice(0, 20).map((el) => ({
    tag: el.tagName.toLowerCase(),
    autoplay: el.autoplay === true,
    muted: el.muted === true || el.hasAttribute("muted"),
    controls: el.hasAttribute("controls"),
    loop: el.hasAttribute("loop"),
  }))`;
  try {
    const target = await pageTarget();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await once(socket, "open", CDP_READY_TIMEOUT_MS);
      const result = waitForResult(socket, 1, AX_TREE_TIMEOUT_MS);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        // `returnByValue` so the result arrives as JSON rather than a remote object handle that would
        // need a second round trip to read.
        params: { expression: EXPRESSION, returnByValue: true },
      }));
      const value = (await result)?.result?.value;
      return Array.isArray(value) ? value : null;
    } finally {
      try { socket.close(); } catch (error) { void error; }
    }
  } catch (error) {
    void error; // a diagnostic probe must never fail a capture; null reads as "not checked"
    return null;
  }
}
