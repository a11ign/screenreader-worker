// This shim is the difference between a sub-second socket rebuild and a ~23s NVDA restart, and the
// restarts are themselves what wedge a guest. It monkey-patches a dependency's transport, so the
// contract it relies on — guidepup reconnects on socket 'error', and only on 'error' — is asserted here
// rather than assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installSpeechChannelShim, resetSpeechSocket, NVDA_REMOTE_PORT } from "./speech-channel.mjs";

class FakeSocket extends EventEmitter {
  destroyed = false;
  keepAlive: { enabled: boolean; ms: number } | null = null;
  destroyedWith: Error | null = null;
  setKeepAlive(enabled: boolean, ms: number) { this.keepAlive = { enabled, ms }; }
  destroy(error?: Error) {
    this.destroyed = true;
    this.destroyedWith = error ?? null;
    // Node's contract: destroy(err) emits 'error' then 'close'; destroy() emits only 'close'.
    if (error) this.emit("error", error);
    this.emit("close");
  }
}

function fakeTls({ brokenKeepAlive = false } = {}) {
  const sockets: FakeSocket[] = [];
  const tls = {
    connect(...args: unknown[]) {
      void args;
      const s = new FakeSocket();
      if (brokenKeepAlive) s.setKeepAlive = () => { throw new Error("not supported"); };
      sockets.push(s);
      return s;
    },
  };
  return { tls, sockets };
}

test("a socket to NVDA's port is tracked and given the keepalive guidepup never sets", () => {
  const { tls } = fakeTls();
  const shim = installSpeechChannelShim({ tls, port: NVDA_REMOTE_PORT });
  const socket = tls.connect(NVDA_REMOTE_PORT, "127.0.0.1", {}) as unknown as FakeSocket;
  assert.equal(shim.state.connects, 1);
  assert.equal(socket.keepAlive?.enabled, true, "guidepup passes no keepAlive; that is the whole fault");
  shim.uninstall();
});

test("reset destroys WITH an error, because 'error' is the only trigger guidepup listens for", () => {
  // destroy() alone emits just 'close', which NVDAClient ignores — the channel would stay down.
  const { tls } = fakeTls();
  const shim = installSpeechChannelShim({ tls });
  const socket = tls.connect(NVDA_REMOTE_PORT, "127.0.0.1", {}) as unknown as FakeSocket;
  let sawError = false;
  socket.on("error", () => { sawError = true; });

  assert.equal(shim.reset("probe heard nothing"), true);
  assert.equal(socket.destroyed, true);
  assert.ok(socket.destroyedWith instanceof Error, "must destroy with an Error, not bare");
  assert.match(socket.destroyedWith!.message, /probe heard nothing/);
  assert.equal(sawError, true, "guidepup's reconnect hangs off this event");
  shim.uninstall();
});

test("connections to other ports are left alone", () => {
  // The patch must be narrow: anything else this process opens over TLS is not ours to touch.
  const { tls } = fakeTls();
  const shim = installSpeechChannelShim({ tls, port: NVDA_REMOTE_PORT });
  const other = tls.connect(443, "example.com", {}) as unknown as FakeSocket;
  assert.equal(shim.state.connects, 0);
  assert.equal(other.keepAlive, null);
  assert.equal(shim.reset("nothing to reset"), false);
  shim.uninstall();
});

test("resetting when there is no socket, or one already destroyed, is a no-op not a throw", () => {
  // Called from the capture path on a probe failure, which can happen before any connection exists.
  const { tls } = fakeTls();
  const shim = installSpeechChannelShim({ tls });
  assert.equal(shim.reset("no socket yet"), false);
  const socket = tls.connect(NVDA_REMOTE_PORT, "127.0.0.1", {}) as unknown as FakeSocket;
  socket.destroy();
  assert.equal(shim.reset("already gone"), false);
  assert.equal(shim.state.resets, 0, "a no-op must not be counted as a reset");
  shim.uninstall();
});

test("the newest socket is the one reset, after guidepup reconnects", () => {
  // guidepup's error handler builds a fresh socket; a later reset must act on that one, not the corpse.
  const { tls } = fakeTls();
  const shim = installSpeechChannelShim({ tls });
  const first = tls.connect(NVDA_REMOTE_PORT, "127.0.0.1", {}) as unknown as FakeSocket;
  shim.reset("first failure");
  const second = tls.connect(NVDA_REMOTE_PORT, "127.0.0.1", {}) as unknown as FakeSocket;
  shim.reset("second failure");
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, true);
  assert.equal(shim.state.connects, 2);
  assert.equal(shim.state.resets, 2);
  shim.uninstall();
});

test("installing twice does not wrap the wrapper", () => {
  const { tls } = fakeTls();
  const original = tls.connect;
  const first = installSpeechChannelShim({ tls });
  const second = installSpeechChannelShim({ tls });
  assert.equal(first, second, "the second install returns the existing handle");
  first.uninstall();
  assert.equal(tls.connect, original, "uninstall restores the original function");
});

test("socket errors and closes are counted, so a degrading channel is visible", () => {
  // The observability half: guidepup has no debug mode, so without this a dying channel is invisible.
  const { tls } = fakeTls();
  const events: string[] = [];
  const shim = installSpeechChannelShim({ tls, onEvent: (e: { type: string }) => events.push(e.type) });
  const socket = tls.connect(NVDA_REMOTE_PORT, "127.0.0.1", {}) as unknown as FakeSocket;
  socket.emit("error", new Error("boom"));
  socket.emit("close");
  assert.equal(shim.state.errors, 1);
  assert.equal(shim.state.closes, 1);
  assert.deepEqual(events, ["connect", "error", "close"]);
  shim.uninstall();
});

test("a socket that refuses keepalive is recorded, not silently ignored", () => {
  // An empty catch here would mean the keepalive half of this module could stop working and nobody
  // would know. The socket is still usable, so this is recorded rather than thrown.
  const { tls } = fakeTls({ brokenKeepAlive: true });
  const events: string[] = [];
  const shim = installSpeechChannelShim({ tls, onEvent: (e: { type: string }) => events.push(e.type) });
  tls.connect(NVDA_REMOTE_PORT, "127.0.0.1", {});
  assert.equal(shim.state.keepAliveFailed, true);
  assert.ok(events.includes("keepalive-failed"));
  shim.uninstall();
});

test("resetSpeechSocket is usable directly on a state object", () => {
  const socket = new FakeSocket();
  // Node throws on an 'error' with no listener. Guidepup always attaches one (NVDAClient line 99) --
  // which is precisely the handler this reset exists to trigger.
  socket.on("error", () => {});
  const state = { socket, resets: 0 };
  assert.equal(resetSpeechSocket(state as never, "direct"), true);
  assert.equal(state.resets, 1);
  assert.equal(socket.destroyed, true);
});
