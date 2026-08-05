/**
 * Rebuild NVDA's speech channel without restarting NVDA.
 *
 * ## The fault
 *
 * Guidepup reaches NVDA over a TLS socket to NVDA Remote on 127.0.0.1:6837. Keystrokes are writes;
 * speech is pushed back as `speak` messages. When that socket goes half-open the writes still succeed
 * and nothing ever comes back, so NVDA looks completely healthy and says nothing.
 *
 * Reading `node_modules/@guidepup/guidepup/lib/windows/NVDA/NVDAClient.js` at 0.29.2 shows why it cannot
 * notice, and every line reference below is to that file:
 *
 *   - `tls.connect(...)` (line 85) passes no `keepAlive` and no `timeout`.
 *   - The ONLY reconnect trigger is the socket `'error'` handler (lines 99-110). A half-open TCP
 *     connection raises no error, so the handler never runs.
 *   - `#send` (line 301) reconnects only when `socket.destroyed` is true. A half-open socket is not
 *     destroyed, so writes go on succeeding into a dead pipe.
 *
 * ## Why this shim rather than our own client
 *
 * Guidepup's reconnect logic is not missing — it is *starved of its trigger*. Lines 99-110 already
 * disconnect, reconnect, re-join the channel and reset the failure counter on success. So the cheapest
 * correct fix is to give it the error it is waiting for: `socket.destroy(err)` emits `'error'`, which
 * runs guidepup's own recovery. We reimplement nothing.
 *
 * We cannot reach the socket through the public API — `NVDA#client` and `NVDAClient#socket` are both
 * true `#private` fields, unreachable by reflection — so the socket is captured where it is created, by
 * wrapping `tls.connect`. That is a deliberate, narrow monkey-patch of one function, applied only to
 * connections to NVDA's port, and it is reversible (`uninstall`).
 *
 * ## What this buys
 *
 * The old remedy for a dead channel was `stop()` + `start()` of NVDA, ~23 s, because that is the only
 * way guidepup's public API can rebuild the connection. Repeated NVDA restarts are also what produce
 * the `nvdaHelperRemote (injection_terminate)` modal that wedges a guest — so the expensive remedy was
 * feeding the fault it was treating. A socket rebuild is sub-second and leaves NVDA untouched.
 *
 * TCP keepalive is set as well, but it is the weaker half: it detects a dead *peer*, and NVDA's process
 * is usually alive and merely not speaking. The probe-and-reset path is what catches that.
 */
import { createRequire } from "node:module";

export const NVDA_REMOTE_PORT = 6837;

/**
 * Everything this module reports about the channel. Always carries a `type`; the rest varies by event.
 * Guidepup has no debug mode -- two env vars and no logging -- so this stream is the only view there is
 * of a connection that otherwise fails silently.
 *
 * @typedef {{ type: string, [key: string]: unknown }} SpeechChannelEvent
 */

/**
 * How often TCP probes a quiet connection. Speech is bursty and long gaps between captures are normal,
 * so this only has to be short enough to notice a genuinely dead peer before the next capture.
 */
const KEEPALIVE_MS = 15_000;

/** Marker so a second install is a no-op rather than a shim wrapping a shim. */
const INSTALLED = Symbol.for("a11y-witness.speechChannelShim");

/**
 * Start tracking a socket, and give it the keepalive guidepup never sets.
 *
 * @param {import("node:net").Socket} socket
 * @param {{ socket: unknown, connects: number, errors: number, closes: number, keepAliveFailed: boolean }} state
 * @param {(event: SpeechChannelEvent) => void} onEvent
 */
function adoptSocket(socket, state, onEvent) {
  state.socket = socket;
  state.connects += 1;
  try {
    socket.setKeepAlive(true, KEEPALIVE_MS);
  } catch (error) {
    // Recorded rather than swallowed: a socket we could not configure still works, but the keepalive
    // half of this module is then not doing anything and that should be visible, not assumed.
    state.keepAliveFailed = true;
    onEvent({ type: "keepalive-failed", detail: error?.message });
  }
  socket.on("error", () => {
    state.errors += 1;
    onEvent({ type: "error", errors: state.errors });
  });
  socket.on("close", () => {
    state.closes += 1;
    onEvent({ type: "close", closes: state.closes });
  });
  onEvent({ type: "connect", connects: state.connects });
}

/**
 * Force guidepup to rebuild the channel, by handing it the socket error it is waiting for.
 *
 * `destroy(err)` rather than `destroy()` matters: destroying without an argument emits only `'close'`,
 * which guidepup does not listen for, so the channel would stay down. With an error it emits `'error'`,
 * and NVDAClient's handler disconnects, reconnects and re-joins the channel on its own.
 *
 * @returns {boolean} false when there was nothing to reset — no socket yet, or already destroyed
 */
export function resetSpeechSocket(state, reason, onEvent = () => {}) {
  const socket = state.socket;
  if (!socket || socket.destroyed) return false;
  state.resets += 1;
  onEvent({ type: "reset", reason, resets: state.resets });
  socket.destroy(new Error(`speech channel reset: ${reason}`));
  return true;
}

/**
 * Wrap `tls.connect` so sockets to NVDA's port are tracked and can be rebuilt on demand.
 *
 * The patch survives NVDAClient.js already being imported, because it compiles to
 * `(0, node_tls_1.connect)(...)` — a property lookup at call time, not a bound reference. `createRequire`
 * is used rather than an ESM import so we mutate the very CommonJS exports object that NVDAClient holds.
 *
 * @param {{ tls?: object, port?: number, onEvent?: (event: SpeechChannelEvent) => void }} options
 */
export function installSpeechChannelShim({ tls, port = NVDA_REMOTE_PORT, onEvent = () => {} } = {}) {
  const tlsModule = tls ?? createRequire(import.meta.url)("node:tls");
  if (tlsModule[INSTALLED]) return tlsModule[INSTALLED];

  const originalConnect = tlsModule.connect;
  const state = { socket: null, connects: 0, resets: 0, errors: 0, closes: 0, keepAliveFailed: false };

  tlsModule.connect = function connect(...args) {
    const socket = originalConnect.apply(this, args);
    // Only NVDA's channel. Anything else this process opens over TLS is none of our business.
    if (args[0] === port) adoptSocket(socket, state, onEvent);
    return socket;
  };

  const handle = {
    state,
    reset: (reason) => resetSpeechSocket(state, reason, onEvent),
    uninstall() {
      tlsModule.connect = originalConnect;
      delete tlsModule[INSTALLED];
    },
  };
  tlsModule[INSTALLED] = handle;
  return handle;
}
