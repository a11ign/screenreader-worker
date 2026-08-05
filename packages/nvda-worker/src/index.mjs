/**
 * The NVDA capture worker's programmatic surface — deliberately small.
 *
 * **The HTTP contract is the real API.** A capture runs on Windows with an interactive desktop, so almost
 * every consumer talks to `server.mjs` over HTTP rather than importing anything. What is exported here is the
 * one-shot entry point and the two identity values a caller needs to reason about compatibility.
 *
 * `CAPTURE_PROTOCOL_VERSION` versions the wire contract **independently of this package's semver**, and
 * conflating them would be expensive in both directions: a package major must not invalidate 2,122 cached
 * captures, and a protocol bump must not wait for a major (ADR 0004).
 *
 * `codeVersion()` is re-exported from its own module rather than from `server.mjs`, because importing
 * `server.mjs` BINDS A PORT — it calls `server.listen()` at module scope.
 */
export { captureWithNvda, CAPTURE_PROTOCOL_VERSION } from "./capture-core.mjs";
export { codeVersion, workerSourceDir } from "./code-version.mjs";
export { WORKER_FILES } from "./worker-files.mjs";
