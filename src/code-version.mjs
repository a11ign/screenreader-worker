// @ts-check
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
 * this used to be two implementations of that — `codeVersion()` inside `server.mjs`, which needs guidepup on
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
  // Line endings are NORMALISED before hashing, and that is load-bearing rather than tidy.
  //
  // A guest that gets its code by `git clone` on Windows can check it out with CRLF, so the same
  // commit hashes differently on the guest and on the host and `worker:code` reports STALE for
  // ever. Measured on the first bare-metal worker: 31979b551b7a2cfa against this checkout's
  // 22822b7a3a08969c, from a clean tree at the same commit — the CRLF conversion of those exact
  // 18 files reproduces the guest's value precisely.
  //
  // It stayed hidden because the UTM guests are built by FILE PUSH, which copies bytes, and this
  // fleet is about to be git-cloned instead. The check whose whole purpose is "does this worker
  // run my code" would have answered no, always, for every new machine.
  //
  // Normalising is also the more correct question: a line ending cannot change what the worker
  // DOES, so a hash that reports it as different code is answering something nobody asked.
  for (const file of WORKER_FILES) {
    hash.update(readFileSync(resolve(dir, file), "utf8").replace(/\r\n/g, "\n"));
  }
  return hash.digest("hex").slice(0, 16);
}
