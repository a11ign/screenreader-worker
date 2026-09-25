// THE CDP DRIVER AGAINST A REAL CHROMIUM (ADR 0038, PR 4): a login over the browser protocol's text insertion, the
// replayed flow, the session purge, and that the purge is what ends the session.
//
// SKIPS, WITH ITS REASON, where no Chromium is installed (CI's `ts` job installs none; `capture-regression.yml` sets
// PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD). The skip is the ONLY thing that can make this file not run, and it says so; a
// dev host that has run `npx playwright install chromium` runs every test here. What the fake-browser tests in
// `auth-flow.test.ts` cannot show, and this one does, is that the real protocol calls do what the interpreter assumes
// they do: `Accessibility.getFullAXTree` names controls the way the flow addresses them, `Input.insertText` lands in
// a focused password field and reaches the server, and `Storage.clearDataForOrigin` really ends a session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCdpDriver, purgeSession, runSteps, signIn, validateAuthRequest } from "./auth-flow.mjs";
import { faultCode, FAULT } from "./capture-faults.mjs";

const FAKE_USER = "canaryuser6d3f2a";
const FAKE_SECRET = "canarysecretb81c94";

/**
 * A Chromium to drive: `A11Y_TEST_CHROMIUM` if set, else Playwright's headless shell (it needs fewer system
 * libraries than the full build, which matters on a host that is not a desktop), else its full Chromium.
 */
async function chromiumPath(): Promise<string | null> {
  const named = process.env.A11Y_TEST_CHROMIUM;
  if (named) return existsSync(named) ? named : null;
  const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  const shells = existsSync(cache)
    ? readdirSync(cache).filter((dir) => dir.startsWith("chromium_headless_shell-"))
      .map((dir) => join(cache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"))
    : [];
  const shell = shells.find((path) => existsSync(path));
  if (shell) return shell;
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    return existsSync(path) ? path : null;
  } catch (error) {
    void error; // no playwright in this tree: the same "no browser" answer
    return null;
  }
}

const CHROMIUM = await chromiumPath();

/**
 * Can this Chromium ACTUALLY START here? A binary that exists is not one that runs: a host without the shared libraries a
 * headless Chromium loads (`libatk`, `libasound`) finds the file and dies on launch, and a suite that then FAILS with
 * "did not open its debugging port" reads as a defect in the code under test. Launched once at load, with the reason
 * printed on the skip, so the answer is "not exercised, and here is why" and never a red that is not about this change.
 */
async function launchProblem(executable: string): Promise<string | null> {
  const probePort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "auth-flow-probe-"));
  const flags = executable.endsWith("chrome-headless-shell") ? [] : ["--headless=new"];
  const child = spawn(executable, [...flags, "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${probePort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let died: string | null = null;
  child.once("error", (error) => { died = error.message; });
  child.once("exit", (code) => { died = `it exited with code ${code} before opening its debugging port`; });
  const answers = async () => (await fetch(`http://127.0.0.1:${probePort}/json/version`).catch(() => null))?.ok === true;
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && died === null) {
      if (await answers()) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return died ?? "it did not open its debugging port within 15 s";
  } finally {
    const exited = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    child.kill("SIGKILL");
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const PROBLEM = CHROMIUM ? await launchProblem(CHROMIUM) : null;
const SKIP = !CHROMIUM
  ? "no Chromium is installed here (run `npx playwright install chromium`); the CDP driver was NOT exercised"
  : PROBLEM ? `Chromium is installed but cannot start here (${PROBLEM}); the CDP driver was NOT exercised` : undefined;

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** A second origin (another port) for the redirect to leave to: the identity provider a real SSO would be. */
async function otherOrigin() {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page("Identity provider", "<h1>Sign in with your organisation</h1>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** A site whose session is a cookie, so the purge can be shown to END something. */
async function site(elsewhere = "http://127.0.0.1:1") {
  const posted: Array<{ user: string; password: string }> = [];
  /** What the page told the server it did: the observable that a control was really operated. */
  const pings: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const signedIn = /(?:^|;\s*)session=ok/.test(req.headers.cookie ?? "");
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html", ...headers });
      res.end(body);
    };
    if ((req.url ?? "").startsWith("/ping")) {
      pings.push(decodeURIComponent((req.url ?? "").slice("/ping?".length)));
      return send(204, "");
    }
    if (req.url === "/login" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        const entry = { user: form.get("user") ?? "", password: form.get("password") ?? "" };
        posted.push(entry);
        if (entry.user === FAKE_USER && entry.password === FAKE_SECRET) {
          send(302, "", { location: "/dashboard", "set-cookie": "session=ok; Path=/; HttpOnly" });
        } else send(200, page("Sign in", "<h1>Sign in</h1><p>Wrong login.</p>"));
      });
      return;
    }
    if (req.url === "/login") {
      send(200, page("Sign in", `<h1>Sign in</h1><form method="post" action="/login">
        <label>Email address <input name="user" type="text"></label>
        <label>Password <input name="password" type="password"></label>
        <button type="submit">Sign in</button></form>`));
    } else if (req.url === "/dashboard" || req.url === "/orders") {
      if (signedIn) send(200, page("Orders", "<h1>Dashboard</h1><a href='/dashboard'>Orders</a>"));
      else send(302, "", { location: "/login" });
    } else if (req.url === "/prefs") {
      send(200, page("Prefs", `<label><input type="checkbox" id="c" onchange="fetch('/ping?remember='+this.checked)"> Remember me</label>
        <label>Country <select id="s" onchange="fetch('/ping?country='+encodeURIComponent(this.value))"><option>France</option><option>United Kingdom</option></select></label>
        <label>Note <textarea id="n" oninput="fetch('/ping?note='+encodeURIComponent(this.value))"></textarea></label>`));
    } else if (req.url === "/leave") {
      send(302, "", { location: elsewhere });
    } else send(404, page("Not found", "<h1>Not found</h1>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, posted, pings, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

/** Launch Chromium with a debugging port on loopback and NO `--remote-debugging-address`, as the worker does. */
async function launch(): Promise<{ port: number; stop: () => Promise<void> }> {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "auth-flow-cdp-"));
  const child: ChildProcess = spawn(CHROMIUM!, [
    ...(CHROMIUM!.endsWith("chrome-headless-shell") ? [] : ["--headless=new"]),
    "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch (error) { void error; /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("Chromium did not open its debugging port");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    port,
    // Waits for the process to be gone before removing its profile: it is still writing to it when killed.
    stop: async () => {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const LOGIN = (extra: object[] = []) => [
  { goto: "/login" },
  { fill: { field: "Email address", fromEnv: "APP_USER" } },
  { fill: { field: "Password", fromEnv: "APP_PASSWORD" } },
  { press: { control: "Sign in" } },
  { expect: { kind: "heading", name: "Dashboard", timeoutSeconds: 10 } },
  ...extra,
];
const ENV = { APP_USER: FAKE_USER, APP_PASSWORD: FAKE_SECRET };

test("a real login over CDP: text inserted into a password field reaches the server, and the session works", { skip: SKIP, timeout: 60_000 }, async () => {
  const web = await site();
  const browser = await launch();
  try {
    const driver = await openCdpDriver({ port: browser.port });
    const marks: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const url = `${web.origin}/orders`;
    await signIn({ plan: validateAuthRequest({ login: LOGIN() }, url), url, driver, env: ENV, mark: (event, detail) => marks.push({ event, detail }) });
    assert.deepEqual(web.posted, [{ user: FAKE_USER, password: FAKE_SECRET }], "the inserted text is what the server received");
    assert.equal(await driver.origin(), web.origin);
    assert.ok((await driver.axNodes()).some((node) => node.role === "heading" && node.name === "Dashboard"), "the requested page is the signed-in one");
    assert.ok(marks.some((m) => m.event === "authApplied"));
    assert.ok(!JSON.stringify(marks).includes(FAKE_USER) && !JSON.stringify(marks).includes(FAKE_SECRET), "no mark carries a value");
    await driver.close();
  } finally { await browser.stop(); await web.close(); }
});

test("THE PURGE ENDS THE SESSION: after purgeSession the same protected page sends the browser to the login", { skip: SKIP, timeout: 60_000 }, async () => {
  const web = await site();
  const browser = await launch();
  try {
    const driver = await openCdpDriver({ port: browser.port });
    const url = `${web.origin}/orders`;
    await signIn({ plan: validateAuthRequest({ login: LOGIN() }, url), url, driver, env: ENV, mark: () => undefined });
    // The control: the session is real, so reloading the protected page does NOT bounce to the login.
    assert.deepEqual(await driver.navigate(url), { ok: true });
    assert.ok((await driver.axNodes()).some((n) => n.role === "heading" && n.name === "Dashboard"), "before the purge the session holds");
    await purgeSession(driver, url);
    await driver.navigate(url);
    const after = await driver.axNodes();
    assert.ok(after.some((n) => n.role === "heading" && n.name === "Sign in"), "after the purge the browser is logged out");
    assert.ok(!after.some((n) => n.role === "heading" && n.name === "Dashboard"));
    await driver.close();
  } finally { await browser.stop(); await web.close(); }
});

test("a wrong password is expect-not-met; an unaddressable control is unbindable-field; a redirect off-origin is left-origin", { skip: SKIP, timeout: 90_000 }, async () => {
  const idp = await otherOrigin();
  const web = await site(idp.origin);
  const browser = await launch();
  try {
    const driver = await openCdpDriver({ port: browser.port });
    const url = `${web.origin}/orders`;
    const run = (login: object[], env = ENV) => signIn({ plan: validateAuthRequest({ login }, url), url, driver, env, mark: () => undefined, bindTimeoutMs: 800 });
    const reasonOf = (promise: Promise<unknown>) => promise.then(() => "no failure", (e: Error & { reason?: string }) => e.reason ?? e.message);
    const shortExpect = { expect: { kind: "heading", name: "Dashboard", timeoutSeconds: 0.5 } };
    assert.equal(await reasonOf(run([...LOGIN().slice(0, 4), shortExpect], { ...ENV, APP_PASSWORD: "not the password" })), "expect-not-met");
    assert.equal(await reasonOf(run([{ goto: "/login" }, { fill: { field: "Username", fromEnv: "APP_USER" } }, shortExpect])), "unbindable-field");
    assert.equal(await reasonOf(run([{ goto: "/leave" }, shortExpect])), "left-origin");
    await driver.close();
  } finally { await browser.stop(); await web.close(); await idp.close(); }
});

test("choose, check and fill act on REAL controls, observed at the server", { skip: SKIP, timeout: 60_000 }, async () => {
  const web = await site();
  const browser = await launch();
  try {
    const driver = await openCdpDriver({ port: browser.port });
    const url = `${web.origin}/orders`;
    const plan = validateAuthRequest({ login: LOGIN(), flow: [
      { goto: "/prefs" }, { check: { field: "Remember me" } }, { choose: { field: "Country", option: "United Kingdom" } },
      { fill: { field: "Note", value: "a literal in a text area is fine" } },
    ] }, url);
    await signIn({ plan, url, driver, env: ENV, mark: () => undefined });
    // `signIn` ends on the requested page, so the flow's own effects are read from what the page told the server.
    await new Promise((resolve) => setTimeout(resolve, 300)); // the pings are fire-and-forget fetches
    assert.deepEqual(web.pings.sort(), ["country=United%20Kingdom", "note=a%20literal%20in%20a%20text%20area%20is%20fine", "remember=true"].map(decodeURIComponent).sort());
    await driver.close();
  } finally { await browser.stop(); await web.close(); }
});

test("a literal typed into a real password field is auth-literal-secret, and is never inserted", { skip: SKIP, timeout: 60_000 }, async () => {
  const web = await site();
  const browser = await launch();
  try {
    const driver = await openCdpDriver({ port: browser.port });
    const url = `${web.origin}/orders`;
    const marks: string[] = [];
    await assert.rejects(runSteps({
      steps: [{ goto: "/login" }, { fill: { field: "Password", value: "hunter2-literal" } }] as never, origin: web.origin, driver, env: ENV,
      mark: (event) => marks.push(event), phase: "flow", bindTimeoutMs: 800,
    }), (e: Error) => {
      assert.equal(faultCode(e), FAULT.AUTH_LITERAL_SECRET);
      assert.ok(!e.message.includes("hunter2-literal"));
      return true;
    });
    // The control: the same field takes a from-env value, so the refusal is about the literal and not the field.
    await runSteps({ steps: [{ fill: { field: "Password", fromEnv: "APP_PASSWORD" } }] as never, origin: web.origin, driver, env: ENV, mark: () => undefined, phase: "flow", bindTimeoutMs: 800 });
    assert.ok(url.length > 0);
    await driver.close();
  } finally { await browser.stop(); await web.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// THE PORT OPENS LATE (#2475). These tests need no Chromium, so they are never skipped: the defect is in what the driver
// does BEFORE it can talk to a browser, and every test above hands it one that is already listening. Edge opens its
// DevTools port about half a second after `openPage` spawns it, and `pageSocketUrl` asked once, so on a real worker every
// authenticated capture died with `connect ECONNREFUSED 127.0.0.1:9222` before the login began.

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * A browser stand-in that speaks just enough of the protocol for `openCdpDriver` to finish: `/json/list` naming one page,
 * and a WebSocket that answers every command with an empty result. It starts NOT listening; `listen()` opens the port.
 */
async function lateBrowser(listResponse: { status: number } = { status: 200 }) {
  const port = await freePort();
  const sockets = new Set<Socket>();
  const asked: string[] = [];
  const server: Server = createServer((req, res) => {
    asked.push(req.url ?? "");
    if (listResponse.status !== 200) { res.writeHead(listResponse.status); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]));
  });
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (frame: Buffer) => {
      // A client frame is masked and, for these commands, shorter than 126 bytes.
      const length = frame[1] & 0x7f;
      const mask = frame.subarray(2, 6);
      const text = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4])).toString();
      const reply = Buffer.from(JSON.stringify({ id: JSON.parse(text).id, result: {} }));
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
    socket.on("error", () => undefined);
  });
  return {
    port, asked,
    listen: () => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

test("a browser that starts listening 500 ms AFTER the driver is asked for still gets driven", { timeout: 30_000 }, async () => {
  const browser = await lateBrowser();
  const LISTENS_AFTER_MS = 500;
  const opening = openCdpDriver({ port: browser.port });
  const late = new Promise<void>((resolve) => setTimeout(() => { void browser.listen().then(resolve); }, LISTENS_AFTER_MS));
  try {
    const driver = await opening;
    await late;
    // The control that the wait was a retry and not luck: nothing answered before the port opened.
    assert.deepEqual(browser.asked, ["/json/list"]);
    await driver.close();
  } finally { await late; await browser.close(); }
});

test("a browser that never listens fails with the named error, inside the bound, and does not hang", { timeout: 30_000 }, async () => {
  const browser = await lateBrowser();
  const BOUND_MS = 600;
  const started = Date.now();
  try {
    await assert.rejects(openCdpDriver({ port: browser.port, readyTimeoutMs: BOUND_MS }), (error: Error) => {
      assert.match(error.message, new RegExp(`^CDP: the DevTools port ${browser.port} did not open within ${BOUND_MS} ms`));
      assert.equal((error.cause as { cause?: { code?: string } })?.cause?.code, "ECONNREFUSED", "the refusal that ran the bound out is kept as the cause");
      return true;
    });
    const waited = Date.now() - started;
    assert.ok(waited >= BOUND_MS, `it waited the bound out (${waited} ms), not less`);
    assert.ok(waited < BOUND_MS + 5_000, `and stopped at it (${waited} ms)`);
  } finally { await browser.close(); }
});

test("only a REFUSED connection is retried: an HTTP error status from a listening browser surfaces at once", { timeout: 30_000 }, async () => {
  const browser = await lateBrowser({ status: 503 });
  await browser.listen();
  const started = Date.now();
  try {
    await assert.rejects(openCdpDriver({ port: browser.port, readyTimeoutMs: 20_000 }), /CDP \/json\/list returned HTTP 503/);
    assert.ok(Date.now() - started < 2_000, "it did not wait for a bound");
    assert.deepEqual(browser.asked, ["/json/list"], "and asked exactly once");
  } finally { await browser.close(); }
});

test("only a REFUSED connection is retried: a listener that drops the connection is a real answer and surfaces at once", { timeout: 30_000 }, async () => {
  const dropped: number[] = [];
  const server = createTcpServer((socket) => { dropped.push(Date.now()); socket.on("error", () => undefined); socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const started = Date.now();
  try {
    await assert.rejects(openCdpDriver({ port: (server.address() as AddressInfo).port, readyTimeoutMs: 20_000 }), (error: Error) => {
      assert.equal(error.message, "fetch failed");
      assert.doesNotMatch(error.message, /did not open/, "not reported as the port never opening");
      return true;
    });
    assert.ok(Date.now() - started < 2_000, "it did not wait for a bound");
    assert.equal(dropped.length, 1, "and asked exactly once");
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
});
