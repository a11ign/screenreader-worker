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
  "server.mjs",
  "worker-recovery.mjs",
  "capture-faults.mjs",
  "diagnostics.mjs",
  "browser-profile.mjs",
  "nvda-logging.mjs",
  "speech-channel.mjs",
  "desktop-dialogs.mjs",
  "windows-trim.mjs",
  "browser-session.mjs",
  "pointer.mjs",
  "worker-files.mjs",
  "code-version.mjs",
];
