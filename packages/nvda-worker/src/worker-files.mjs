// @ts-check
/**
 * The files that make up the worker's code version — ONE definition, deployed with the worker.
 *
 * There were two copies of this list and a third derived by regex: `server.mjs` hashed it for `/health.code`,
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
  "capture-core.mjs",
  "capture-pure.mjs",
  // Split out of `server.mjs` so a Linux test can import it without reaching guidepup; the guest runs
  // it, so it is hashed like every other worker file. `code-version.test.ts` refused the split until it
  // was listed here, which is that guard working.
  "file-version.mjs",
  "server.mjs",
  "server-log.mjs",
  "worker-recovery.mjs",
  "capture-faults.mjs",
  "error-text.mjs",
  "capture-results.mjs",
  "diagnostics.mjs",
  "browser-profile.mjs",
  "nvda-logging.mjs",
  "speech-channel.mjs",
  "desktop-dialogs.mjs",
  // Split out of `server.mjs` so a Linux test can import `prepareDesktop` without reaching guidepup; the
  // guest runs it (`server.mjs` imports it for the real capture path), so it is hashed like every other
  // worker file. Same shape as `file-version.mjs` above, for the identical reason.
  "desktop-prepare.mjs",
  // The forms-config matcher (ADR 0024). capture-core imports it, so a guest without it cannot start —
  // which is exactly what `worker-files.test.ts` caught when this line was missing.
  "field-match.mjs",
  "powershell.mjs",
  "window-focus.mjs",
  "windows-trim.mjs",
  "browser-session.mjs",
  "browsers.mjs",
  "pointer.mjs",
  "worker-files.mjs",
  "code-version.mjs",
];
