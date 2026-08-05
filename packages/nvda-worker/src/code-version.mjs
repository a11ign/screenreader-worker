/**
 * What code is this worker running? One hash, computed the same way on both sides.
 *
 * Deploying is push-then-restart and both halves can fail silently. `utmctl exec` returns success and no
 * output whether or not it ran anything — measured: on two cloned guests the restart never happened, the
 * workers served the previous process for another hour, and the hash check meant to catch that ALSO went
 * through `exec`, so it came back empty rather than mismatched. **A verification that shares a failure mode
 * with the action verifies nothing.** So the worker reports its own code over the channel it serves on:
 * `/health` is reachable exactly when the worker is usable.
 *
 * That comparison is only meaningful if the guest and the host hash the same bytes in the same order, and
 * this used to be two implementations of that — `codeVersion()` inside `server.mjs`, which binds a port on
 * import, and `localVersion()` in `check-worker-code.mjs`. Same loop, same order, written twice. The file
 * LIST was already unified into `worker-files.mjs`; this is the other half.
 *
 * It also has to be importable without starting a server, because the package exports `codeVersion()`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_FILES } from "./worker-files.mjs";

/** Where the worker's own source lives — resolved from this module, so any cwd works. */
export const workerSourceDir = () => fileURLToPath(new URL("./", import.meta.url));

/**
 * The worker's code hash over `dir` (defaults to this module's own directory).
 *
 * The host passes its checkout; the guest gets its own installed copy. Order is part of the contract.
 */
export function codeVersion(dir = workerSourceDir()) {
  const hash = createHash("sha256");
  for (const file of WORKER_FILES) hash.update(readFileSync(resolve(dir, file)));
  return hash.digest("hex").slice(0, 16);
}
