// THE SEAM BETWEEN A CAPTURE AND ITS LOGIN (`capture-auth.mjs`), against a real Chromium on the worker's OWN DevTools
// port (ADR 0038, PR 4): sign in, land on the requested page through `navigateExisting` (the navigation the capture
// path uses), and destroy the session afterwards — including when the login failed.
//
// `navigateExisting` reads `CDP_PORT` (9222) and takes no port argument, so this launches Chromium on that port and
// SKIPS, with its reason, if there is no Chromium or the port is taken (a real worker, or another test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CDP_PORT } from "./browser-session.mjs";
import { validateAuthRequest } from "./auth-flow.mjs";
import { beginAuthentication } from "./capture-auth.mjs";
import { faultCode, FAULT } from "./capture-faults.mjs";

const FAKE_USER = "canaryuser6d3f2a";
const FAKE_SECRET = "canarysecretb81c94";
const ENV = { APP_USER: FAKE_USER, APP_PASSWORD: FAKE_SECRET };

function chromium(): string | null {
  const named = process.env.A11Y_TEST_CHROMIUM;
  if (named) return existsSync(named) ? named : null;
  const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  const shell = readdirSync(cache).filter((dir) => dir.startsWith("chromium_headless_shell-"))
    .map((dir) => join(cache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell")).find((path) => existsSync(path));
  return shell ?? null;
}

async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

const CHROMIUM = chromium();
const SKIP = !CHROMIUM
  ? "no headless Chromium is installed here (run `npx playwright install chromium`); the seam was NOT exercised"
  : (await portIsFree(CDP_PORT)) ? undefined : `something already listens on the worker's DevTools port ${CDP_PORT}; the seam was NOT exercised`;

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

async function site() {
  const server: Server = createServer((req, res) => {
    const signedIn = /(?:^|;\s*)session=ok/.test(req.headers.cookie ?? "");
    const send = (status: number, body: string, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "text/html", ...headers }); res.end(body); };
    if (req.url === "/login" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        if (form.get("user") === FAKE_USER && form.get("password") === FAKE_SECRET) send(302, "", { location: "/orders", "set-cookie": "session=ok; Path=/" });
        else send(200, html("Sign in", "<h1>Sign in</h1><p>Wrong login.</p>"));
      });
    } else if (req.url === "/login") {
      send(200, html("Sign in", `<h1>Sign in</h1><form method="post" action="/login"><label>Email address <input name="user"></label>
        <label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`));
    } else if (req.url === "/orders") {
      if (signedIn) send(200, html("Orders", "<h1>Dashboard</h1>"));
      else send(302, "", { location: "/login" });
    } else send(404, html("Not found", "<h1>Not found</h1>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

async function launch(startUrl: string): Promise<() => Promise<void>> {
  const profile = mkdtempSync(join(tmpdir(), "capture-auth-cdp-"));
  const child: ChildProcess = spawn(CHROMIUM!, ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, startUrl], { stdio: "ignore" });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break; } catch (error) { void error; /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("Chromium did not open its debugging port");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return async () => {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}

const LOGIN = [
  { goto: "/login" },
  { fill: { field: "Email address", fromEnv: "APP_USER" } },
  { fill: { field: "Password", fromEnv: "APP_PASSWORD" } },
  { press: { control: "Sign in" } },
  { expect: { kind: "heading", name: "Dashboard", timeoutSeconds: 10 } },
];

const marksOf = () => {
  const marks: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  return { marks, diag: { mark: (event: string, detail?: Record<string, unknown>) => { marks.push({ event, detail }); } } };
};

test("beginAuthentication signs in, lands on the requested page, and end() destroys the session", { skip: SKIP, timeout: 60_000 }, async () => {
  const web = await site();
  const stop = await launch(`${web.origin}/orders`);
  try {
    const url = `${web.origin}/orders`;
    const { marks, diag } = marksOf();
    const authentication = await beginAuthentication({ plan: validateAuthRequest({ login: LOGIN }, url), url, diag, env: ENV });
    assert.equal(marks[marks.length - 1].event, "authApplied", "the acknowledgement is the last mark");
    assert.ok(!JSON.stringify(marks).includes(FAKE_USER) && !JSON.stringify(marks).includes(FAKE_SECRET), "no mark carries a value");
    await authentication.end();
    assert.ok(marks.some((m) => m.event === "authPurge"), "the purge is recorded");
    // The session is really gone: a fresh look at the protected page is sent to the login.
    const again = await beginAuthentication({ plan: validateAuthRequest({ login: [{ goto: "/orders" }, { expect: { kind: "heading", name: "Sign in", timeoutSeconds: 5 } }] }, url), url, diag: marksOf().diag, env: ENV });
    await again.end();
  } finally { await stop(); await web.close(); }
});

test("a login that FAILS still ends the session: the purge runs and the failure is rethrown, unchanged", { skip: SKIP, timeout: 60_000 }, async () => {
  const web = await site();
  const stop = await launch(`${web.origin}/orders`);
  try {
    const url = `${web.origin}/orders`;
    const { marks, diag } = marksOf();
    await assert.rejects(beginAuthentication({
      plan: validateAuthRequest({ login: [...LOGIN.slice(0, 4), { expect: { kind: "heading", name: "Dashboard", timeoutSeconds: 0.5 } }] }, url),
      url, diag, env: { ...ENV, APP_PASSWORD: "not the password" },
    }), (e: Error & { reason?: string }) => faultCode(e) === FAULT.AUTH_LOGIN_FAILED && e.reason === "expect-not-met");
    assert.ok(marks.some((m) => m.event === "authPurge"), "the failed login was still purged");
    assert.ok(!marks.some((m) => m.event === "authApplied"), "and never acknowledged");
  } finally { await stop(); await web.close(); }
});

test("a missing variable is found before the browser is driven at all", { skip: SKIP, timeout: 30_000 }, async () => {
  const web = await site();
  const stop = await launch(`${web.origin}/orders`);
  try {
    const url = `${web.origin}/orders`;
    const { marks, diag } = marksOf();
    await assert.rejects(beginAuthentication({ plan: validateAuthRequest({ login: LOGIN }, url), url, diag, env: { APP_USER: FAKE_USER } }),
      (e: Error) => faultCode(e) === FAULT.AUTH_CREDENTIAL_MISSING);
    assert.deepEqual(marks, [], "nothing was recorded, because nothing was done");
  } finally { await stop(); await web.close(); }
});

test("a purge that cannot run is RECORDED and does not throw: it runs in a finally and must not replace the capture's outcome", { skip: SKIP, timeout: 60_000 }, async () => {
  const web = await site();
  const stop = await launch(`${web.origin}/orders`);
  const url = `${web.origin}/orders`;
  try {
    const { marks, diag } = marksOf();
    const authentication = await beginAuthentication({ plan: validateAuthRequest({ login: LOGIN }, url), url, diag, env: ENV });
    await stop(); // the browser goes away under it
    await authentication.end();
    assert.ok(marks.some((m) => m.event === "authPurgeFailed"), "the failure is on the record");
    await authentication.end(); // idempotent
  } finally { await web.close(); }
});
