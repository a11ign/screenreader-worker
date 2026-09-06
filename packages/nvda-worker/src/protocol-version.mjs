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
 * from `capture-core.mjs` or `@a11y-witness/nvda-worker` is unchanged; `deploy-worker.mjs` and
 * `check-worker-code.mjs` (in `@a11y-witness/worker-fleet`, which already depends on this package) now
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
export const CAPTURE_PROTOCOL_VERSION = 16;
