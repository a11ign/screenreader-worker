/**
 * The files that make up the worker's code version — ONE definition, deployed with the worker.
 *
 * There were two copies of this list and a third derived by regex: `server.ts` hashed it for `/health.code`,
 * `check-worker-code.mjs` hashed it on the host to compare, and `deploy-worker.mjs` parsed the second one's
 * SOURCE to know what to push. Every copy had to agree on the contents **and the order**, or `/health.code`
 * compares a different set than was deployed and reports a mismatch that means nothing.
 *
 * The deploy script's own comment said why that mattered: "a file missing from the list deploys invisibly."
 * That is this repo's most expensive recurring shape — a fix applied at one site when the behaviour reaches
 * several — so the list is a module now, and it is in its own list so it is hashed and pushed like the rest.
 *
 * Order is part of the contract: the hash is a sha256 over the file contents in sequence.
 */
export const WORKER_FILES = [
  "capture-core.ts",
  // Split out of `capture-core.ts` so portable/host-side code can import CAPTURE_PROTOCOL_VERSION
  // directly instead of regex-scraping this file's text — architecture-audit.md §5, item 3. `capture-core`
  // imports it, so the guest runs it and it is hashed and deployed like every other worker file.
  "protocol-version.ts",
  // Split out of `capture-core.ts` 2026-09-05 (browser/NVDA lifecycle, and structural-navigation/probes
  // respectively). The guest runs both -- `capture-core.ts` imports from each -- so they are hashed and
  // deployed like every other worker file, on the same rule `desktop-prepare.ts` and `field-match.ts`
  // above already record: a file missing from this list deploys invisibly.
  "capture-setup.ts",
  "capture-probes.ts",
  "capture-pure.ts",
  // Split out of `server.ts` so a Linux test can import it without reaching guidepup; the guest runs
  // it, so it is hashed like every other worker file. `code-version.test.ts` refused the split until it
  // was listed here, which is that guard working.
  "file-version.ts",
  "server.ts",
  "server-log.ts",
  "worker-recovery.ts",
  "capture-faults.ts",
  "error-text.ts",
  "capture-results.ts",
  "diagnostics.ts",
  "browser-profile.ts",
  "nvda-logging.ts",
  "speech-channel.ts",
  "desktop-dialogs.ts",
  // Split out of `server.ts` so a Linux test can import `prepareDesktop` without reaching guidepup; the
  // guest runs it (`server.ts` imports it for the real capture path), so it is hashed like every other
  // worker file. Same shape as `file-version.ts` above, for the identical reason.
  "desktop-prepare.ts",
  // The display mode and adapter, sampled on a timer so `/health` never shells out (#2673). `server.ts` imports
  // it, so a guest without it cannot start; guidepup-free for the same reason as the two files above.
  "display-sample.ts",
  // The forms-config matcher (ADR 0024). capture-core imports it, so a guest without it cannot start —
  // which is exactly what `worker-files.test.ts` caught when this line was missing.
  "field-match.ts",
  "powershell.ts",
  "window-focus.ts",
  "windows-trim.ts",
  "browser-session.ts",
  "browsers.ts",
  "pointer.ts",
  // ADR 0038's login interpreter and CDP driver. `capture-core.ts` and `server.ts` import it, so a guest without
  // it cannot start — the same reason as every file above.
  "auth-flow.ts",
  // The seam between `capture-core.ts` and `auth-flow.ts`: it reaches the browser session and the capture's marks,
  // which the interpreter deliberately does not. `capture-core.ts` imports it, so it is deployed like the rest.
  "capture-auth.ts",
  "worker-files.ts",
  "code-version.ts",
];
