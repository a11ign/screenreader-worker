// A LOGIN THAT PASSES THROUGH A DECLARED IDENTITY-PROVIDER ORIGIN, IN THE WORKER'S INTERPRETER (a11y-witness #4088, #4084 outcome 1).
//
// The CLI's half is `packages/cli/src/auth/idp-origins.test.ts` in a11y-witness, and the two files hold the SAME scenarios and the SAME
// sentences as literals: there are two interpreters because there cannot be one, so this is where their agreement is pinned from the
// worker's side. `idpOrigins` arrives over HTTP from anywhere, so it is validated again here, and never echoed in a refusal.
//
// 1. The FAKE DRIVER (an app origin, a declared IdP origin, a third origin): the allowance's edges, one test each, each beside its CONTROL.
// 2. VALIDATION of `auth.idpOrigins` at the worker's boundary.
// 3. The real CDP driver's `url()` against a real Chromium. SKIPS, with its reason, where none starts here.
// 4. A `loginBlock` (a11ign#4998): the worker's screen loop wired into `signIn` over a scripted multi-screen identity provider, and the
//    block's validation at the wire. The loop's own cases are `screen-loop.test.ts`; here is what the WIRING must hold: nothing typed into
//    an undeclared origin, a value read from a NAMED variable at the moment it is typed, a fault from the closed list, no value in any mark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsPresent, AuthRequestError, openCdpDriver, signIn, validateAuthRequest } from "./auth-flow.ts";
import { beginAuthentication } from "./capture-auth.ts";
import { FAULT } from "./capture-faults.ts";
import { totpCode } from "./totp.ts";

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
  `the login did not complete (left-origin) at ${where}: the page is on ${now}, not ${APP}. A redirect to an identity provider this flow does not declare ends the run: declare its origin under idp-origins: in the flows file if it signs in with a form. SSO beyond that is not supported: use a dedicated test account without MFA or SSO.`;

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
// A `loginBlock`: the screen loop over a scripted identity provider.
// ---------------------------------------------------------------------------------------------------------------

// The RFC 6238 SHA-1 seed. It is the canary here as well as the secret: no mark, message or fault may carry it.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const BLOCK_ENV = { IDP_USER: "idp-user-canary-1f", IDP_PASSWORD: "idp-password-canary-9c", IDP_TOTP: SEED };
const LOGIN_PAGE = `${APP}/login`;

type Node = { role: string; name: string; autocomplete?: string; parent?: number };
type Screen = { origin: string; path: string; nodes: Node[] };

const idp = (path: string, nodes: Node[]): Screen => ({ origin: IDP, path, nodes });
const IDENTIFIER_SCREEN = idp("/u/login/identifier", [
  { role: "heading", name: "Welcome" }, { role: "textbox", name: "Email address", autocomplete: "username" }, { role: "button", name: "Continue" },
]);
const PASSWORD_SCREEN = idp("/u/login/password", [
  { role: "heading", name: "Enter your password" }, { role: "textbox", name: "Password", autocomplete: "current-password" }, { role: "button", name: "Continue" },
]);
const CODE_SCREEN = idp("/u/mfa-otp-challenge", [
  { role: "heading", name: "Verify your identity" }, { role: "textbox", name: "Enter the code", autocomplete: "one-time-code" }, { role: "button", name: "Continue" },
]);
const ACCOUNT_SCREEN: Screen = { origin: APP, path: "/account", nodes: [{ role: "heading", name: "Account" }] };
const NAMED_CHECK = { role: "heading", name: "Account" };

/**
 * An identity provider as a script of screens: pressing a button or Enter moves to the next, typed text is recorded by field and
 * origin, and the alert text is carried as an `alert` with static text beneath it, as the accessibility tree has it.
 */
function screenSite(screens: Screen[], options: { wall?: Screen; jumpAfterFirstFill?: boolean } = {}) {
  let at = 0;
  let started = false;
  let walled = false;
  const typed: Array<{ origin: string; field: string; text: string }> = [];
  const marks: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const here = () => (walled && options.wall ? options.wall : screens[at]);
  const nodes = () => here().nodes.map((node, i) => ({
    id: String(i + 1), role: node.role, name: node.name, backendId: i + 1, ignored: false,
    ...(node.parent === undefined ? {} : { parentId: String(node.parent + 1) }),
  }));
  const advance = () => { at = Math.min(at + 1, screens.length - 1); };
  const driver = {
    navigate: async () => {
      if (started && at === screens.length - 1 && options.wall) walled = true; // the requested page, after a login that "worked"
      started = true;
      return { ok: true };
    },
    origin: async () => here().origin,
    url: async () => `${here().origin}${here().path}`,
    axNodes: async () => nodes(),
    autocompleteOf: async (handle: number) => here().nodes[handle - 1]?.autocomplete ?? "",
    frameSources: async () => [],
    inputType: async (handle: number) => (here().nodes[handle - 1]?.name === "Password" ? "password" : "text"),
    fill: async (handle: number, text: string) => {
      assert.ok(text.length > 0);
      typed.push({ origin: here().origin, field: here().nodes[handle - 1]?.name ?? "?", text });
      if (options.jumpAfterFirstFill && typed.length === 1) advance(); // a page that navigates on input, between two fields of one form
    },
    choose: async () => false,
    isChecked: async () => false,
    click: async (handle: number) => { if (here().nodes[handle - 1]?.role === "button" || here().nodes[handle - 1]?.role === "link") advance(); },
    pressEnter: async () => { advance(); },
    setCookies: async () => undefined,
    setLocalStorage: async () => undefined,
    purge: async () => undefined,
    close: async () => undefined,
  };
  return { driver, typed, marks, mark: (event: string, detail: Record<string, unknown>) => { marks.push({ event, detail }); } };
}

type BlockWire = Record<string, unknown>;
const blockWire = (over: BlockWire = {}): BlockWire => ({
  loginBlock: { url: LOGIN_PAGE, usernameEnv: "IDP_USER", passwordEnv: "IDP_PASSWORD", totpEnv: "IDP_TOTP", check: NAMED_CHECK, ...over },
  idpOrigins: [IDP],
});

type BlockRun = { ok: true } | { ok: false; fault: unknown; reason: unknown; message: string };

async function runBlock(wire: BlockWire, site: ReturnType<typeof screenSite>, env: Record<string, string | undefined> = BLOCK_ENV): Promise<BlockRun> {
  try {
    const plan = validateAuthRequest(wire, ACCOUNT_URL);
    assertCredentialsPresent(plan, env);
    await signIn({ plan, url: ACCOUNT_URL, driver: site.driver as never, env, mark: site.mark, bindTimeoutMs: 250, loopBudgetMs: 5_000 });
    return { ok: true };
  } catch (error) {
    const e = error as Error & { code?: string; fault?: string; reason?: string };
    return { ok: false, fault: e.fault ?? e.code, reason: e.reason, message: e.message };
  }
}

const failedWith = (outcome: BlockRun, fault: string) => {
  assert.ok(!outcome.ok, "expected the login to fail");
  if (!outcome.ok) assert.equal(outcome.fault, fault, outcome.message);
  return outcome.ok ? "" : outcome.message;
};

const nothingSecretIn = (text: string) => {
  for (const canary of Object.values(BLOCK_ENV)) assert.ok(!text.includes(canary), `a value reached a mark or a message: ${canary}`);
};

test("POSITIVE CONTROL: identifier, password, one-time code, signed in — each typed once, on the declared IdP, from the NAMED variables", async () => {
  const site = screenSite([IDENTIFIER_SCREEN, PASSWORD_SCREEN, CODE_SCREEN, ACCOUNT_SCREEN]);
  const before = Date.now();
  assert.deepEqual(await runBlock(blockWire(), site), { ok: true });
  const after = Date.now();
  assert.deepEqual(site.typed.map(({ origin, field }) => `${origin} ${field}`), [`${IDP} Email address`, `${IDP} Password`, `${IDP} Enter the code`]);
  assert.equal(site.typed[0].text, BLOCK_ENV.IDP_USER);
  assert.equal(site.typed[1].text, BLOCK_ENV.IDP_PASSWORD);
  const windows = [totpCode(SEED, before), totpCode(SEED, after)];
  assert.ok(windows.includes(site.typed[2].text), "the code is the authenticator window's, made at the moment it was typed");
  assert.ok(site.marks.some((mark) => mark.event === "authApplied"));
  nothingSecretIn(JSON.stringify(site.marks));
  assert.ok(!JSON.stringify(site.marks).includes(site.typed[2].text), "the code itself is in no mark");
});

test("POSITIVE CONTROL: the same screens on the app's own origin need no idpOrigins, and the combined form is typed in one go", async () => {
  const combined: Screen = { origin: APP, path: "/login", nodes: [
    { role: "heading", name: "Log in" }, { role: "textbox", name: "Email address", autocomplete: "username" },
    { role: "textbox", name: "Password", autocomplete: "current-password" }, { role: "button", name: "Log in" },
  ] };
  const site = screenSite([combined, ACCOUNT_SCREEN]);
  const wire = blockWire();
  delete wire.idpOrigins;
  assert.deepEqual(await runBlock(wire, site), { ok: true });
  assert.deepEqual(site.typed.map(({ field }) => field), ["Email address", "Password"]);
});

test("NEGATIVE CONTROL: a request carrying a VALUE where a variable NAME belongs is refused, naming the key and never the value", () => {
  const literals: Array<[string, string]> = [
    ["usernameEnv", "alice@example.com"],
    ["passwordEnv", "p@ss w0rd! literal"],
    ["totpEnv", "otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP"],
  ];
  for (const [key, literal] of literals) {
    assert.throws(() => validateAuthRequest(blockWire({ [key]: literal }), ACCOUNT_URL), (e: Error) => {
      assert.ok(e instanceof AuthRequestError);
      assert.ok(e.message.includes(`auth.loginBlock.${key}`), e.message);
      assert.ok(!e.message.includes(literal) && !e.message.includes("JBSWY3DPEHPK3PXP"), "the value is never echoed back");
      return true;
    });
  }
  for (const key of ["usernameEnv", "passwordEnv", "totpEnv"]) {
    assert.throws(() => validateAuthRequest(blockWire({ [key]: 42 }), ACCOUNT_URL), AuthRequestError, `${key} must be text`);
    assert.throws(() => validateAuthRequest(blockWire({ [key]: undefined }), ACCOUNT_URL), AuthRequestError, `${key} is required`);
  }
});

test("CONTROL: the same block with real variable names validates, and its plan holds names and no values", () => {
  const plan = validateAuthRequest(blockWire({ organization: "acme" }), ACCOUNT_URL);
  assert.deepEqual(plan.loginBlock, {
    url: LOGIN_PAGE, usernameEnv: "IDP_USER", passwordEnv: "IDP_PASSWORD", totpEnv: "IDP_TOTP", check: NAMED_CHECK, organization: "acme",
  });
  assert.deepEqual(plan.login, []);
  assert.equal("loginBlock" in validateAuthRequest({ login: LOGIN }, ACCOUNT_URL), false, "a steps login keeps its old shape");
});

test("NEGATIVE CONTROL: a block is refused for a key this worker does not define, both login forms at once, a saved state, or a URL off the app", () => {
  const refuse = (wire: BlockWire, includes: string) => assert.throws(() => validateAuthRequest(wire, ACCOUNT_URL), (e: Error) => {
    assert.ok(e instanceof AuthRequestError);
    assert.ok(e.message.includes(includes), e.message);
    return true;
  });
  refuse(blockWire({ fields: { password: "Contraseña" } }), "fields");
  refuse(blockWire({ surprise: true }), "surprise");
  refuse({ ...blockWire(), login: LOGIN }, "both login and loginBlock");
  refuse({ ...blockWire(), state: { path: "/tmp/state.json" } }, "auth.state");
  refuse(blockWire({ url: `${THIRD}/login` }), "auth.loginBlock.url leaves");
  refuse(blockWire({ url: "javascript:alert(1)" }), "auth.loginBlock.url");
  refuse(blockWire({ check: { url: `${THIRD}/account` } }), "auth.loginBlock.check.url");
  refuse(blockWire({ check: { url: "//third.example.test/account" } }), "auth.loginBlock.check.url");
  refuse(blockWire({ check: { role: "heading", name: "Account", url: "/account" } }), "not both");
  refuse(blockWire({ check: {} }), "auth.loginBlock.check");
  refuse(blockWire({ organization: "" }), "auth.loginBlock.organization");
});

test("a url check is a path on the app's origin, whether sent as a path or as an absolute URL on it", () => {
  const asPath = validateAuthRequest(blockWire({ check: { url: "/account" } }), ACCOUNT_URL).loginBlock;
  const asUrl = validateAuthRequest(blockWire({ check: { url: `${APP}/account?x=1` } }), ACCOUNT_URL).loginBlock;
  assert.deepEqual(asPath?.check, { url: "/account" });
  assert.deepEqual(asUrl?.check, { url: "/account" });
});

test("a missing username or password variable is refused BEFORE anything is typed, naming the variable; a malformed secret likewise, never its value", () => {
  const plan = validateAuthRequest(blockWire(), ACCOUNT_URL);
  assert.throws(() => assertCredentialsPresent(plan, { ...BLOCK_ENV, IDP_PASSWORD: undefined }), (e: Error & { fault?: string; code?: string }) => {
    assert.equal(e.fault ?? e.code, FAULT.AUTH_CREDENTIAL_MISSING);
    assert.match(e.message, /IDP_PASSWORD/);
    return true;
  });
  const typo = "NOT-A-BASE32-SEED-with-0189";
  assert.throws(() => assertCredentialsPresent(plan, { ...BLOCK_ENV, IDP_TOTP: typo }), (e: Error & { fault?: string; code?: string }) => {
    assert.equal(e.fault ?? e.code, FAULT.AUTH_CREDENTIAL_MISSING);
    assert.match(e.message, /IDP_TOTP/);
    assert.ok(!e.message.includes(typo), "the secret is never echoed back");
    return true;
  });
  assert.doesNotThrow(() => assertCredentialsPresent(plan, { ...BLOCK_ENV, IDP_TOTP: undefined }), "an account with no MFA needs no secret");
});

test("NEGATIVE CONTROL: an unrecognised screen ends auth-login-failed carrying the step text, and nothing is typed or pressed", async () => {
  const odd = idp("/u/nickname", [{ role: "heading", name: "Pick a nickname" }, { role: "textbox", name: "Nickname" }, { role: "button", name: "Save nickname" }]);
  const site = screenSite([odd, ACCOUNT_SCREEN]);
  const outcome = await runBlock(blockWire(), site);
  const message = failedWith(outcome, FAULT.AUTH_LOGIN_FAILED);
  assert.ok(!outcome.ok && outcome.reason === "unknown-screen");
  assert.match(message, /press: \{ control: "Save nickname" \}/);
  assert.deepEqual(site.typed, []);
  nothingSecretIn(message);
});

test("NEGATIVE CONTROL: a bot check ends auth-challenge-detected at once; nothing is typed, and the CAPTCHA is never answered", async () => {
  const bot = idp("/u/captcha", [{ role: "heading", name: "One more step" }, { role: "checkbox", name: "I'm not a robot" }]);
  const site = screenSite([bot, ACCOUNT_SCREEN]);
  failedWith(await runBlock(blockWire(), site), FAULT.AUTH_CHALLENGE_DETECTED);
  assert.deepEqual(site.typed, []);
});

test("NEGATIVE CONTROL: wrong credentials end the login after ONE typing: the alert is read from its static text and the form is not retried", async () => {
  const combined = idp("/u/login", [
    { role: "heading", name: "Log in" }, { role: "textbox", name: "Email address", autocomplete: "username" },
    { role: "textbox", name: "Password", autocomplete: "current-password" }, { role: "button", name: "Log in" },
  ]);
  const rejected = idp("/u/login", [...combined.nodes, { role: "alert", name: "" }, { role: "StaticText", name: "Wrong email or password", parent: combined.nodes.length }]);
  const site = screenSite([combined, rejected, ACCOUNT_SCREEN]);
  const outcome = await runBlock(blockWire(), site);
  failedWith(outcome, FAULT.AUTH_LOGIN_FAILED);
  assert.ok(!outcome.ok && outcome.reason === "credentials-rejected");
  assert.deepEqual(site.typed.map(({ field }) => field), ["Email address", "Password"], "each typed once");
});

test("NEGATIVE CONTROL: a code screen with no secret configured ends mfa-required-no-seed without typing a code", async () => {
  const site = screenSite([IDENTIFIER_SCREEN, PASSWORD_SCREEN, CODE_SCREEN, ACCOUNT_SCREEN]);
  const outcome = await runBlock(blockWire(), site, { ...BLOCK_ENV, IDP_TOTP: undefined });
  failedWith(outcome, FAULT.AUTH_LOGIN_FAILED);
  assert.ok(!outcome.ok && outcome.reason === "mfa-required-no-seed");
  assert.deepEqual(site.typed.map(({ field }) => field), ["Email address", "Password"]);
});

test("NEGATIVE CONTROL: a login page on an origin the flow did not declare is left-origin, and nothing is typed into it", async () => {
  const site = screenSite([IDENTIFIER_SCREEN, PASSWORD_SCREEN, ACCOUNT_SCREEN]);
  const wire = blockWire();
  delete wire.idpOrigins;
  const outcome = await runBlock(wire, site);
  failedWith(outcome, FAULT.AUTH_LOGIN_FAILED);
  assert.ok(!outcome.ok && outcome.reason === "left-origin");
  assert.deepEqual(site.typed, []);
  // A page on an origin nobody declared is not READ either: what it shows does not decide the outcome, its origin does.
  const stranger = screenSite([{ origin: THIRD, path: "/u/nickname", nodes: [{ role: "heading", name: "Pick a nickname" }] }, ACCOUNT_SCREEN]);
  const strangerOutcome = await runBlock(wire, stranger);
  assert.ok(!strangerOutcome.ok && strangerOutcome.reason === "left-origin", "named by origin, not as an unknown screen");
});

test("NEGATIVE CONTROL: a form that moves to an undeclared origin between its two fields gets only the first typed", async () => {
  const combined = idp("/u/login", [
    { role: "heading", name: "Log in" }, { role: "textbox", name: "Email address", autocomplete: "username" },
    { role: "textbox", name: "Password", autocomplete: "current-password" }, { role: "button", name: "Log in" },
  ]);
  const elsewhere: Screen = { origin: THIRD, path: "/u/login", nodes: combined.nodes };
  const site = screenSite([combined, elsewhere, ACCOUNT_SCREEN], { jumpAfterFirstFill: true });
  const outcome = await runBlock(blockWire(), site);
  failedWith(outcome, FAULT.AUTH_LOGIN_FAILED);
  assert.ok(!outcome.ok && outcome.reason === "left-origin");
  assert.deepEqual(site.typed.map(({ origin, field }) => `${origin} ${field}`), [`${IDP} Email address`], "the password was not typed into the stranger");
});

test("NEGATIVE CONTROL: a check the signed-out start page already satisfies is refused before any value is typed", async () => {
  const alreadyThere: Screen = { origin: APP, path: "/login", nodes: [{ role: "heading", name: "Account" }, ...IDENTIFIER_SCREEN.nodes] };
  const site = screenSite([alreadyThere, ACCOUNT_SCREEN]);
  const outcome = await runBlock(blockWire(), site);
  failedWith(outcome, FAULT.AUTH_LOGIN_FAILED);
  assert.ok(!outcome.ok && outcome.reason === "signed-in-check-matches-signed-out");
  assert.deepEqual(site.typed, []);
});

test("NEGATIVE CONTROL: the budget stops a loop that never reaches the check, and a page that never matched is named, not typed into", async () => {
  const spinner = idp("/u/wait", [{ role: "heading", name: "Loading" }]);
  const site = screenSite([spinner, ACCOUNT_SCREEN]);
  const plan = validateAuthRequest(blockWire(), ACCOUNT_URL);
  await assert.rejects(
    signIn({ plan, url: ACCOUNT_URL, driver: site.driver as never, env: BLOCK_ENV, mark: site.mark, bindTimeoutMs: 250, loopBudgetMs: 700 }),
    (e: Error & { reason?: string }) => e.reason === "unknown-screen",
  );
  assert.deepEqual(site.typed, []);
});

test("a login that works and then lands the requested page on the login form is auth-session-lost, as a steps login is", async () => {
  const login: Screen = { origin: APP, path: "/login", nodes: [
    { role: "heading", name: "Log in" }, { role: "textbox", name: "Email address", autocomplete: "username" },
    { role: "textbox", name: "Password", autocomplete: "current-password" }, { role: "button", name: "Log in" },
  ] };
  const site = screenSite([login, ACCOUNT_SCREEN], { wall: login });
  const wire = blockWire();
  delete wire.idpOrigins;
  const outcome = await runBlock(wire, site);
  failedWith(outcome, FAULT.AUTH_SESSION_LOST);
  assert.equal(site.marks.some((mark) => mark.event === "authApplied"), false);
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
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    // One text field and no button: Enter in it is the only way this form submits (implicit submission), which `pressEnter` must do.
    res.end(req.url?.startsWith("/form")
      ? "<!doctype html><title>f</title><form action=\"/submitted\"><input name=\"q\" aria-label=\"Code\" autocomplete=\"one-time-code\"></form>"
      : "<!doctype html><title>x</title><h1>Account</h1>");
  });
  const port = await listening(site);
  const driver = await openCdpDriver({ port: (browser as { port: number }).port });
  try {
    assert.ok(driver.url, "the shipped driver says where the page is");
    await driver.navigate(`http://127.0.0.1:${port}/account?tab=1`);
    assert.equal(await driver.url?.(), `http://127.0.0.1:${port}/account?tab=1`);
    await driver.navigate(`http://127.0.0.1:${port}/other`);
    assert.equal(await driver.url?.(), `http://127.0.0.1:${port}/other`);
    // The screen loop's two reads and presses (a11ign#4998): the `autocomplete` token of a control, and Enter in a form with no button.
    await driver.navigate(`http://127.0.0.1:${port}/form`);
    const code = (await driver.axNodes()).find((node) => node.role === "textbox" && node.name === "Code");
    assert.ok(code?.backendId !== undefined, "the field is in the accessibility tree by its name");
    assert.equal(await driver.autocompleteOf?.(code.backendId), "one-time-code");
    await driver.pressEnter?.(code.backendId);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !String(await driver.url?.()).includes("/submitted")) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(String(await driver.url?.()).includes("/submitted"), "Enter submitted the form");
  } finally {
    await driver.close();
    await new Promise<void>((resolve) => { site.close(() => resolve()); site.closeAllConnections(); });
    await (browser as { stop: () => Promise<void> }).stop();
  }
});

// ---- the seam: the window is marked navigated whether or not the requested page was loaded again (`capture-auth.ts`) -----------------

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
