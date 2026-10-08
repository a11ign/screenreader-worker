// A LOGIN THAT PASSES THROUGH A DECLARED IDENTITY-PROVIDER ORIGIN, IN THE WORKER'S INTERPRETER (a11y-witness #4088, #4084 outcome 1).
//
// The CLI's half is `packages/cli/src/auth/idp-origins.test.ts` in a11y-witness, and the two files hold the SAME scenarios and the SAME
// sentences as literals: there are two interpreters because there cannot be one, so this is where their agreement is pinned from the
// worker's side. `idpOrigins` arrives over HTTP from anywhere, so it is validated again here, and never echoed in a refusal.
//
// 1. The FAKE DRIVER (an app origin, a declared IdP origin, a third origin): the allowance's edges, one test each, each beside its CONTROL.
// 2. VALIDATION of `auth.idpOrigins` at the worker's boundary.
// 3. The real CDP driver's `url()` against a real Chromium. SKIPS, with its reason, where none starts here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthRequestError, openCdpDriver, signIn, validateAuthRequest } from "./auth-flow.mjs";
import { beginAuthentication } from "./capture-auth.mjs";

const APP = "https://app.example.test";
const IDP = "https://idp.example.test";
const THIRD = "https://third.example.test";
const ACCOUNT_URL = `${APP}/account`;
const ENV = { IDP_USER: "idp-user-canary-1f", IDP_PASSWORD: "idp-password-canary-9c" };

type Step = Record<string, unknown>;
const expectAccount: Step = { expect: { kind: "heading", name: "Account", timeoutSeconds: 1 } };
const LOGIN: Step[] = [
  { goto: "/login" },
  { fill: { field: "Email", fromEnv: "IDP_USER" } },
  { fill: { field: "Password", fromEnv: "IDP_PASSWORD" } },
  { press: { control: "Sign in" } },
  expectAccount,
];

type SiteOptions = { hopsTo?: string; driftsToThird?: boolean; signOutLeavesForIdp?: boolean };

/** The sentence a person reads, and that BOTH interpreters must print for the same refusal (the CLI's test holds the same literal). */
const leftOriginSentence = (where: string, now: string) =>
  `the login did not complete (left-origin) at ${where}: the page is on ${now}, not ${APP}. A redirect to an identity provider is SSO, which v1 does not do: use a dedicated test account without MFA or SSO.`;

/** An app, a declared identity provider that signs in with a form, and a third origin; typed values and the order of pages are recorded. */
function fakeSite(options: SiteOptions = {}) {
  let origin = "null";
  let path = "";
  let signedIn = false;
  let drifting = false;
  const typed: Array<{ origin: string; field: string }> = [];
  const visited: string[] = [];
  const nodesFor = (): Array<[string, string]> => {
    if (origin === IDP || origin === THIRD) return path.startsWith("/authorize") ? [["heading", "Log in to continue"], ["textbox", "Email"], ["textbox", "Password"], ["button", "Sign in"]] : [];
    if (origin === APP && path === "/account" && signedIn) return [["heading", "Account"], ...(options.signOutLeavesForIdp ? [["button", "Sign out"] as [string, string]] : [])];
    return [];
  };
  const nodes = () => nodesFor().map(([role, name], i) => ({ id: String(i + 1), role, name, backendId: i + 1, ignored: false }));
  const moveTo = (to: string, at: string) => { origin = to; path = at; visited.push(`${to}${at}`); };
  const driver = {
    navigate: async (url: string) => {
      const target = new URL(url);
      if (target.origin === APP && target.pathname === "/login") moveTo(IDP, "/authorize"); // the app's /login redirects to the provider
      else moveTo(target.origin, target.pathname);
      drifting = options.driftsToThird === true && target.pathname === "/login";
      return { ok: true };
    },
    origin: async () => {
      const answer = origin;
      if (drifting) { drifting = false; moveTo(THIRD, "/authorize"); }
      return answer;
    },
    url: async () => `${origin}${path}`,
    axNodes: async () => nodes(),
    frameSources: async () => [],
    inputType: async (handle: number) => (nodes()[handle - 1]?.name === "Password" ? "password" : "text"),
    fill: async (handle: number, text: string) => { assert.ok(text.length > 0); typed.push({ origin, field: nodes()[handle - 1]?.name ?? "?" }); },
    choose: async () => false,
    isChecked: async () => false,
    click: async (handle: number) => {
      const name = nodes()[handle - 1]?.name;
      if (name === "Sign in" && origin === IDP) { signedIn = options.hopsTo === undefined; moveTo(options.hopsTo ?? APP, options.hopsTo === undefined ? "/account" : "/callback"); }
      if (name === "Sign out") moveTo(IDP, "/logout");
    },
    setCookies: async () => undefined,
    setLocalStorage: async () => undefined,
    purge: async () => undefined,
    close: async () => undefined,
  };
  return { driver, typed, visited };
}

type Run = { ok: true } | { ok: false; reason: unknown; fault: unknown; message: string };

/** One run of `signIn` through the worker's interpreter, with the plan validated the way a request's is. */
async function run(wire: { login: Step[]; flow?: Step[]; idpOrigins?: string[] }, site: ReturnType<typeof fakeSite>): Promise<Run> {
  try {
    const plan = validateAuthRequest(wire, ACCOUNT_URL);
    await signIn({ plan, url: ACCOUNT_URL, driver: site.driver as never, env: ENV, mark: () => undefined, bindTimeoutMs: 250 });
    return { ok: true };
  } catch (error) {
    const e = error as Error & { code?: string; fault?: string; reason?: string };
    return { ok: false, reason: e.reason, fault: e.fault ?? e.code, message: e.message };
  }
}

const refusedAs = (outcome: Run, sentence: string) => {
  assert.ok(!outcome.ok, "expected the run to be refused");
  if (!outcome.ok) {
    assert.equal(outcome.reason, "left-origin");
    assert.equal(outcome.message, sentence);
  }
};

test("IdP declared: the login signs in through the IdP, types only into the declared origin, and ends on the app's Account page", async () => {
  const site = fakeSite();
  assert.deepEqual(await run({ login: LOGIN, idpOrigins: [IDP] }, site), { ok: true });
  assert.deepEqual(site.typed, [{ origin: IDP, field: "Email" }, { origin: IDP, field: "Password" }]);
  assert.equal(site.visited.at(-1), `${APP}/account`);
});

test("CONTROL: the SAME flow with idpOrigins removed ends left-origin at the first step, and types nothing", async () => {
  const site = fakeSite();
  refusedAs(await run({ login: LOGIN }, site), leftOriginSentence("login step 1 (goto)", IDP));
  assert.deepEqual(site.typed, []);
});

test("a SECOND origin that is not declared ends left-origin though the first is: the IdP redirects on to a third origin", async () => {
  refusedAs(await run({ login: LOGIN, idpOrigins: [IDP] }, fakeSite({ hopsTo: THIRD })), leftOriginSentence("login step 4 (press)", THIRD));
});

test("CONTROL for the second origin: declaring it too lets the same hop through that step, and the last step still wants the app", async () => {
  const outcome = await run({ login: LOGIN, idpOrigins: [IDP, THIRD] }, fakeSite({ hopsTo: THIRD }));
  assert.ok(!outcome.ok);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "expect-not-met", "step 4 passed, so the refusal is at step 5 and is the missing heading, not the origin");
    assert.match(outcome.message, /at login step 5 \(expect\)/);
  }
});

test("a login that ends PARKED on the IdP is left-origin at its last step, not a pass", async () => {
  const parked: Step[] = [{ goto: "/login" }, { expect: { kind: "heading", name: "Log in to continue", timeoutSeconds: 1 } }];
  refusedAs(await run({ login: parked, idpOrigins: [IDP] }, fakeSite()), leftOriginSentence("login step 2 (expect)", IDP));
});

test("an expect in the MIDDLE of the login may be met on the declared IdP (the page the next step acts on)", async () => {
  const middle: Step[] = [{ goto: "/login" }, { expect: { kind: "heading", name: "Log in to continue", timeoutSeconds: 1 } }, ...LOGIN.slice(1)];
  assert.deepEqual(await run({ login: middle, idpOrigins: [IDP] }, fakeSite()), { ok: true });
});

test("nothing is typed into an undeclared origin even when the page moves there on its own after the last check", async () => {
  const site = fakeSite({ driftsToThird: true });
  refusedAs(await run({ login: LOGIN, idpOrigins: [IDP] }, site), leftOriginSentence("login step 2 (fill)", THIRD));
  assert.deepEqual(site.typed, []);
});

test("the allowance ends with the login: a flow step that lands on the declared IdP is left-origin", async () => {
  const flow: Step[] = [{ press: { control: "Sign out" } }];
  refusedAs(await run({ login: LOGIN, flow, idpOrigins: [IDP] }, fakeSite({ signOutLeavesForIdp: true })), leftOriginSentence("flow step 1 (press)", IDP));
});

test("a declared flow that ends ON the requested page does not load it again; an undeclared flow, or a driver without url(), does", async () => {
  const loads = async (wire: { login: Step[]; idpOrigins?: string[] }, withUrl: boolean) => {
    const site = fakeSite();
    const driver = withUrl ? site.driver : { ...site.driver, url: undefined };
    const plan = validateAuthRequest(wire, ACCOUNT_URL);
    await signIn({ plan, url: ACCOUNT_URL, driver: driver as never, env: ENV, mark: () => undefined, bindTimeoutMs: 250 });
    return site.visited.filter((page) => page === `${APP}/account`).length;
  };
  assert.equal(await loads({ login: LOGIN, idpOrigins: [IDP] }, true), 1, "the login lands on /account once and it is left alone");
  assert.equal(await loads({ login: LOGIN, idpOrigins: [IDP] }, false), 2, "CONTROL: a driver that cannot say where it is loads the page again");
});

test("auth.idpOrigins is normalised, de-duplicated, and absent means none (the plan keeps its old shape)", () => {
  assert.equal("idpOrigins" in validateAuthRequest({ login: LOGIN }, ACCOUNT_URL), false);
  assert.deepEqual(validateAuthRequest({ login: LOGIN, idpOrigins: ["https://IDP.example.test:443", "https://idp.example.test/"] }, ACCOUNT_URL).idpOrigins, [IDP]);
});

test("auth.idpOrigins refuses a wildcard, a path, a credential, a query, the app's own origin, a non-http scheme and a non-list, never echoing the entry", () => {
  const refusals: Array<[unknown, string]> = [
    ["https://*.example.test", "wildcard"],
    ["https://idp.example.test/oauth", "path"],
    ["https://idp.example.test?x=1", "path"],
    ["https://user:secret@idp.example.test", "username or password"],
    [APP, "app's own origin"],
    [`${APP}/`, "app's own origin"],
    ["ftp://idp.example.test", "http or https"],
    [42, "not a text"],
  ];
  for (const [entry, why] of refusals) {
    assert.throws(() => validateAuthRequest({ login: LOGIN, idpOrigins: [entry] }, ACCOUNT_URL), (e: Error) => {
      assert.ok(e instanceof AuthRequestError);
      assert.match(e.message, /^auth\.idpOrigins entry 1 /);
      assert.ok(e.message.includes(why), `${String(entry)}: ${e.message}`);
      assert.ok(!e.message.includes("secret"), "a credential in an origin is never echoed back");
      return true;
    });
  }
  assert.throws(() => validateAuthRequest({ login: LOGIN, idpOrigins: "https://idp.example.test" }, ACCOUNT_URL), AuthRequestError);
});

// ---------------------------------------------------------------------------------------------------------------
// The real CDP driver's url().
// ---------------------------------------------------------------------------------------------------------------

/** A Chromium to drive: `A11Y_TEST_CHROMIUM` if set, else Playwright's headless shell. */
function chromiumPath(): string | null {
  const named = process.env.A11Y_TEST_CHROMIUM;
  if (named) return existsSync(named) ? named : null;
  const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  const shells = existsSync(cache) ? readdirSync(cache).filter((dir) => dir.startsWith("chromium_headless_shell-")) : [];
  return shells.map((dir) => join(cache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell")).find((path) => existsSync(path)) ?? null;
}

const listening = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

/** Launch a headless Chromium on a debugging port. Returns why it could not, rather than throwing: that is a stated skip. */
async function launchChromium(): Promise<{ port: number; stop: () => Promise<void> } | { reason: string }> {
  const executable = chromiumPath();
  if (executable === null) return { reason: "no Chromium is installed here (run `npx playwright install chromium`)" };
  const probe = createServer();
  const port = await listening(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const profile = mkdtempSync(join(tmpdir(), "auth-flow-idp-"));
  const child = spawn(executable, ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let died: string | null = null;
  child.once("error", (error) => { died = error.message; });
  child.once("exit", (code) => { died = `it exited with code ${code} before opening its debugging port`; });
  const stop = async () => {
    const exited = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    child.kill("SIGKILL");
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && died === null) {
    if ((await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok === true) return { port, stop };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  return { reason: died ?? "it did not open its debugging port within 15 s" };
}

const browser = await launchChromium();
const SKIP = "reason" in browser ? `Chromium cannot start here (${browser.reason}); the CDP driver's url() was NOT exercised` : undefined;
console.log(SKIP === undefined ? "auth-flow-idp: real Chromium started, the CDP test runs" : `auth-flow-idp: SKIPPING the CDP test: ${SKIP}`);

test("the CDP driver's url() is the page's full address, query and all, and moves with a navigation", { skip: SKIP }, async () => {
  const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>x</title><h1>Account</h1>"); });
  const port = await listening(site);
  const driver = await openCdpDriver({ port: (browser as { port: number }).port });
  try {
    assert.ok(driver.url, "the shipped driver says where the page is");
    await driver.navigate(`http://127.0.0.1:${port}/account?tab=1`);
    assert.equal(await driver.url?.(), `http://127.0.0.1:${port}/account?tab=1`);
    await driver.navigate(`http://127.0.0.1:${port}/other`);
    assert.equal(await driver.url?.(), `http://127.0.0.1:${port}/other`);
  } finally {
    await driver.close();
    await new Promise<void>((resolve) => { site.close(() => resolve()); site.closeAllConnections(); });
    await (browser as { stop: () => Promise<void> }).stop();
  }
});

// ---- the seam: the window is marked navigated whether or not the requested page was loaded again (`capture-auth.mjs`) -----------------

const noDiag = { mark: () => undefined };

test("SEAM: a declared login that ends on the requested page is NOT loaded again, and the window is STILL marked navigated for NVDA", async () => {
  const site = fakeSite();
  let marks = 0;
  const plan = validateAuthRequest({ login: LOGIN, idpOrigins: [IDP] }, ACCOUNT_URL);
  await beginAuthentication({ plan, url: ACCOUNT_URL, diag: noDiag, env: ENV, openDriver: async () => site.driver as never, markNavigated: () => { marks += 1; } });
  assert.equal(site.visited.filter((visit) => visit === `${APP}/account`).length, 1, "the requested page was visited once, by the login, and not navigated to again");
  assert.equal(marks, 1);
});

test("CONTROL: a login that fails is not marked, because the capture does not go on", async () => {
  const site = fakeSite();
  let marks = 0;
  const plan = validateAuthRequest({ login: LOGIN }, ACCOUNT_URL); // the same flow, IdP undeclared: left-origin
  await assert.rejects(beginAuthentication({ plan, url: ACCOUNT_URL, diag: noDiag, env: ENV, openDriver: async () => site.driver as never, markNavigated: () => { marks += 1; } }));
  assert.equal(marks, 0);
});
