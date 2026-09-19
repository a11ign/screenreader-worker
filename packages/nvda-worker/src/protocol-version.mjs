// @ts-check
/**
 * `CAPTURE_PROTOCOL_VERSION`, on its own with NO imports — architecture-audit.md §5, item 3.
 *
 * MOVED HERE from `capture-core.mjs`, which imports guidepup and therefore cannot be loaded from any
 * PORTABLE tree (the lab, the CLI, `worker-fleet`) — `no-win32-imports.test.ts` forbids exactly that,
 * because guidepup constructs a `ScreenReader` at import time that throws on Linux, where the lab runs.
 * So four host-side modules that need this ONE number read it by regex-scraping `capture-core.mjs`'s
 * source text instead: `deploy-worker.mjs`, `check-worker-code.mjs`, `protocol-guard.mjs`'s callers, and
 * `control/src/fleet-playbook.mjs`. That has teeth now, not just tidiness: this value moved 14 -> 15 on
 * 2026-09-05 for a real cache-key reason (below), and a scraper whose regex or path has quietly drifted
 * reports the OLD number as though nothing changed.
 *
 * This file is the same shape as `worker-files.mjs`, `code-version.mjs` and `capture-pure.mjs` — a bare
 * constant, safe to import from anywhere, so the number can be READ rather than parsed out of prose.
 * `capture-core.mjs` imports and re-exports it, so every existing importer of `CAPTURE_PROTOCOL_VERSION`
 * from `capture-core.mjs` or `@a11ign/nvda-worker` is unchanged; `deploy-worker.mjs` and
 * `check-worker-code.mjs` (in `@a11ign/worker-fleet`, which already depends on this package) now
 * import it directly for the WORKING-TREE value. The git-HEAD comparison both scripts also make cannot
 * become an import — `git show HEAD:<path>` returns historical file TEXT, not a loadable module — so that
 * half stays a regex by necessity, not by omission.
 *
 * `packages/control/src/fleet-playbook.mjs` keeps its own regex-scrape permanently: ADR 0012 makes that
 * package deliberately dependency-free (`dependencies: {}`, enforced by its own test) to keep the
 * credential that can reconfigure the whole fleet off npm's transitive surface, so it cannot import this
 * subpath — or anything else — regardless of how safe the imported code is. That is not a defect to close.
 */

/**
 * 14 -> 15 on 2026-09-05, because THREE NEW EVIDENCE CHANNELS SHIPPED AND THE CACHE COULD NOT SEE THEM.
 *
 * `focusEvents` (2.4.7's F55 detector), `focusReveal` (1.4.13) and `candidates` on the census/focus marks
 * are all new fields that a RULE reads, which is this constant's own stated trigger — *"a new field a
 * signal reads"*. None of them bumped it, and `workerCode` is deliberately outside the cache key, so
 * every case whose PAGE did not change kept its pre-probe capture.
 *
 * MEASURED, not reasoned. `rules:coverage` in the 2026-09-05 chain reported
 * **`2.4.7 partial 0 0 NEVER FIRED ANYWHERE — the claim rests on nothing`**, and the F55 cases exist:
 * nine `focus-removed-on-receipt-*` cases, built specifically to exercise it. Fetching
 * `focus-removed-on-receipt-order.bad` explains it in one line — captured `07:01:11Z`, hours before the
 * probe existed, with `focusOrder` and `focusConfinement` in its marks and no `focusEventLog` at all, and
 * carrying the OLD `formProbe` mark name rather than `formFill`. The rule was silent because the evidence
 * was never collected, not because the page does not exhibit the failure.
 *
 * WHY NEW CASES HID IT. A case with no cache entry captures fresh, so 1.4.13's cases — added the same day
 * — got the new probe and the rule fired 15 times. The F55 cases are OLDER, their pages did not change,
 * and they were served from cache. So the corpus looked partly working, which is the worst way for this
 * to present: a probe that reaches only the cases nobody had captured before is indistinguishable from a
 * probe that works.
 *
 * This is what the bump is FOR and the cost is the point: a full recapture, ~4 hours of fleet time. The
 * alternative was downgrading 2.4.7's claim in `criterion-coverage.ts` while the rule, the probe and nine
 * corpus cases all sat there working — paying nothing and knowing nothing.
 *
 * The three channels are bundled deliberately, per this repo's own rule that the cheap moment to pay a
 * recapture is alongside any other pending bump rather than twice.
 */
/**
 * 16 -> 17 on 2026-09-11, because `formInputs` (#170) is a new field a RULE AND A SIGNAL READ.
 *
 * 1.3.5's `addUnidentifiedInputPurpose` (`packages/judge/src/rules.ts`) and the `inputPurposeInvalid`
 * signal have read `capture.formInputs` since #869, and until #170 no worker populated it: every capture on
 * disk lacks it, which both readers correctly treat as NOT CHECKED. #170's census fills it from the DOM.
 *
 * WITHOUT A BUMP IT WOULD PRESENT AS 14 -> 15 DID, partly working. #869's five 1.3.5 cases were captured
 * fresh under 16 on 2026-09-11 (#957, product-manager's reading on #170), before the census existed, so the cache would keep serving them
 * without `formInputs` and they would stay BLIND while any case captured later fired -- "a probe that
 * reaches only the cases nobody had captured before is indistinguishable from a probe that works". And a
 * corpus half on one shape and half on another is the mixed-dataset rule in another currency. ceo's ruling,
 * via product-manager on #170.
 *
 * The cost is a full recapture, paid in orchestrator's fleet window alongside #953's half 2, and deployed
 * with `--allow-protocol-change` there and nowhere else.
 *
 * #972 RIDES THE SAME 17, by ceo's ruling: the 17 deploy was held until 09:00Z for it, so one recapture covers
 * both. It changes what a capture DOES -- focus is returned to the top document before the sweeps when #953's
 * `focusInFrame` shows it inside a frame nothing of ours put it in (6 of 6 on #951's page) -- and marks a sweep
 * that still starts inside a frame incomplete (`heldBy`). Had it missed the window it would have been 18.
 */
/**
 * 17 -> 18 on 2026-09-13, because #1363 CHANGES WHAT A CAPTURE DOES -- #972's reason for riding 17.
 *
 * Rehearsal 2 (#915): on `https://www.w3.org/WAI` the probe activated the W3C's embedded YouTube player, the tab
 * became youtube.com, and every probe after it read Google's page under w3.org's key. Under 18 the probe refuses a
 * control announced inside a frame or embedded object, and an activation that leaves the page's site ends the
 * capture there (`interaction.leftSite`): nothing more is pressed, the sweep stops, and the later probes are skipped.
 *
 * A v17 capture whose probe pressed an embed carries ANOTHER SITE'S evidence under this page's key. Served beside
 * v18 captures it would not be a mixed corpus but wrong data kept valid -- `ceo`'s ruling for the bump on #1376.
 * The recapture rides orchestrator's #914 fleet batch, deployed with `--allow-protocol-change` there only. The
 * Action path never reads the capture cache, so rehearsal 3 is unaffected.
 */
/**
 * 18 -> 19 on 2026-09-19, `ceo`'s ruling (a) on #1506 -- ONE bump carrying FOUR meaning changes rather
 * than two full cache misses for one change of meaning (rejecting option (c)).
 *
 * - **#1506 (focus-reveal probe):** `interaction.focusReveal.revealed` stops crediting focus for content
 *   that arrived on its own. A page that read `revealed: true` from late content now reads `false`.
 *   1.4.13's `addFocusRevealFindings`, outcomes and coverage all read the field.
 * - **#1561 (window pin):** the capture window's width joins `environmentKey` and `MUST_MATCH`. #1561
 *   keeps that code; the bump moved here so it lands once, at the same time as the other three.
 * - **#1575 (skipped-focus channels):** a live excursion's `observed` block now records `focusReveal` and
 *   `focusEvents` as not run -- the record `outcomes` and `coverage` read to say "examined and clean"
 *   versus "not examined" for 1.4.13 and 2.4.7 on a left-site capture.
 * - **#1549 (DOM census hidden headings):** `dom.heading` stops counting headings `checkVisibility()`
 *   reports hidden -- merged 2026-09-14 (935d51879) and inert until this bump, the same mixed-dataset
 *   shape as 16 -> 17. `check-real-page-findings.ts` reads the field.
 * - **#1467 (formChanges own-context fragment), the conditional fifth, on main when this row was
 *   claimed (`1247cacf`):** `interaction.formChanges[].after` stops recording the pressed control's own
 *   landmark, name or role fragment. Capture-side, not a reading-side strip -- it changes what
 *   `pageSpeechAfter` records, so a v18 capture is not byte-identical under the new code, and the
 *   exception `ceo` named for a no-op strip does not apply.
 *
 * **Why it is safe.** No v18 capture on disk changes meaning: nothing is written under the old key. The
 * dispatch constraint on #914 -- no capture dispatched at code including #1506 until this bump is on main
 * and deployed -- is content-keyed on #1506, not on this row's position in merge order; a later ruling
 * on this row's own done-when 3 (#1573, `ceo`) confirmed that explicitly after 13 unrelated PRs merged
 * between the post-transfer publish (`b373d1d7d0f8`, 2026-09-19T09:44:24Z) and this one, none of them
 * touching this file, `.changeset/`, or otherwise affecting capture-protocol-relevant code.
 *
 * The cost is a full recapture, paid once for all five reasons, in orchestrator's fleet window after
 * this merges and redeploys.
 */
export const CAPTURE_PROTOCOL_VERSION = 19;
