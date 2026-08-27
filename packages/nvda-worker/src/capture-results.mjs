// @ts-check
/**
 * Recent capture outcomes, so a lost RESPONSE does not destroy a finished capture.
 *
 * ## The fault this exists for
 *
 * `send(res, 200, {...})` writes the result to a socket and the worker then retains nothing. So any socket
 * loss between "NVDA finished reading the page" and "the host parsed the JSON" throws away 30-520 s of real
 * screen-reader work, and the host cannot tell that outcome apart from a worker that never answered. It
 * retries, pays for the whole capture again, and on a bad network can do that repeatedly — three failures
 * in a row on one worker evicts a machine that was never faulty.
 *
 * On three UTM guests sharing one Mac the socket was a virtual bridge and effectively lossless, which is why
 * this never mattered before. A fleet of bare-metal mini PCs is real Ethernet with real power management, and
 * the incident is already recorded in provisioning: a worker answered `EHOSTUNREACH` for every request in an
 * evidence-check run — 48 instant failures — then answered a curl thirty seconds later.
 *
 * ## Why the id comes from the CLIENT
 *
 * The obvious design is for the worker to mint an id and return it. That cannot work here: the failure being
 * recovered from is precisely the one where the response is lost, so a worker-minted id would be lost with
 * it. The host therefore names the capture in the REQUEST, and can ask about it afterwards whatever happened
 * to the socket. This is the idempotency-key shape, for the same reason payment APIs use it.
 *
 * ## What is stored, and why it is the whole response
 *
 * A failed capture is kept exactly like a successful one, with its original status code, so a replay is
 * byte-identical to what the POST returned. That keeps the recovery path from becoming a second, subtly
 * different way to interpret a capture — and it preserves the thing this project cares most about: the
 * worker is the component that knows WHY a capture failed, and its `fault` code must survive the round trip.
 * A transport error replacing a diagnosis with "no answer" is the failure mode, not merely the lost bytes.
 *
 * ## Bounded, and never at the expense of a live capture
 *
 * Captures average ~6 KB on the corpus (34 MB across 2,122 files), so a handful costs nothing on a 4 GB
 * guest. The bound is on COUNT and eviction skips anything still running: evicting a live capture would
 * recreate the original bug at the moment the store was supposed to prevent it.
 *
 * Deliberately in memory only. Persisting it would mean a worker serving results captured under a different
 * `codeVersion` after a restart, and the evidence rules here are unforgiving about that.
 */

/**
 * How many recent captures a worker can still be asked about.
 *
 * Small on purpose. Recovery is worth attempting for seconds-to-minutes after a capture, not hours: the host
 * either notices the lost response on the request it just made, or it has already moved on and re-queued the
 * case. A large history would only add memory and the chance of answering with something stale.
 */
export const RESULT_HISTORY = 8;

/** Ids reach us over the wire and go into a URL path, so the shape is checked at the boundary. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {unknown} id
 * @returns {id is string}
 */
export function isValidCaptureId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/**
 * The HTTP answer for a recall, as data.
 *
 * Separated from the route so it can be tested at all: `server.mjs` binds a port on import, so anything
 * decided inside it is decided where no test can reach — and this endpoint's whole value is in three
 * answers that must not collapse into two.
 *
 *   400  the id is not a shape we accept
 *   404  never heard of it        -> the capture never started; re-issue the case
 *   202  running                  -> wait; do NOT start a second capture
 *   the original status and body  -> use it exactly as if the POST had returned it
 *
 * @param {{ state: "running" | "done", status?: number, body?: unknown } | undefined} entry
 * @param {unknown} id
 */
export function storedResultResponse(entry, id) {
  if (!isValidCaptureId(id)) return { status: 400, body: { error: "invalid capture id" } };
  if (!entry) return { status: 404, body: { error: "no such capture", captureId: id } };
  if (entry.state === "running") return { status: 202, body: { state: "running", captureId: id } };
  // The ORIGINAL status, so a recovered failure still carries its fault code and no caller needs a second
  // way to interpret a capture.
  return { status: entry.status, body: entry.body };
}

/**
 * @param {{ limit?: number }} [options]
 */
export function createResultStore({ limit = RESULT_HISTORY } = {}) {
  /**
   * DISCRIMINATED, not a loose bag with optional fields.
   *
   * It was `{ state: "running" | "done", status?: number, body?: unknown }`, which permits
   * `{ state: "done" }` carrying no status at all -- and the whole point of this store is that a replay
   * is byte-identical to the original response, `fault` code and status included. The looser type could
   * not express that, so it could not protect it. `recall` already DOCUMENTED the union below; the map
   * simply disagreed, which nothing could see while this file was outside `tsc`.
   *
   * @type {Map<string, { state: "running" } | { state: "done", status: number, body: unknown }>}
   */
  const entries = new Map();

  /**
   * Note that a capture with this id has started, so a caller asking early is told "running", not "unknown".
   * @param {unknown} id
   */
  function begin(id) {
    if (!isValidCaptureId(id)) return;
    // Insertion order is eviction order, and a retry reusing an id should be treated as the newest thing
    // here rather than the oldest.
    entries.delete(id);
    entries.set(id, { state: "running" });
    evictOldestDone();
  }

  /**
   * Record the response the caller is about to be sent -- status included, so a replay is identical.
   * @param {unknown} id
   * @param {{ status: number, body: unknown }} response
   */
  function finish(id, { status, body }) {
    if (!isValidCaptureId(id)) return;
    entries.set(id, { state: "done", status, body });
    evictOldestDone();
  }

  /**
   * @returns {{ state: "running" } | { state: "done", status: number, body: unknown } | undefined}
   *   undefined means we have never heard of this capture, which is a different answer from "not finished"
   *   and must stay that way: one says re-issue the case, the other says wait.
   * @param {unknown} id
   */
  function recall(id) {
    // The same boundary check `begin` and `finish` make, which this one silently did not. It cannot
    // change an answer -- an id those two rejected was never stored, so the lookup already missed -- but
    // "unknown id" and "malformed id" reaching the same line by different routes is how a validated
    // boundary quietly becomes an unvalidated one. `isValidCaptureId` is a type predicate, so it also
    // says out loud that only a checked string ever indexes this map.
    if (!isValidCaptureId(id)) return undefined;
    return entries.get(id);
  }

  function evictOldestDone() {
    while (entries.size > limit) {
      const victim = [...entries].find(([, entry]) => entry.state === "done");
      // Every entry is running: the bound yields rather than dropping a live capture, which is the exact
      // loss this store exists to prevent. It self-corrects as those captures finish.
      if (!victim) return;
      entries.delete(victim[0]);
    }
  }

  return { begin, finish, recall, size: () => entries.size };
}
