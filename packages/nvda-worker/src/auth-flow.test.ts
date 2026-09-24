// THE WORKER'S LOGIN (ADR 0038): validated again on arrival, refused from a peer that is not this machine, run over
// a driver, and never recording a value.
//
// The interpreter is driven here over a FAKE browser (a small in-memory site), so every decision it makes — what it
// refuses, what it says, what it never records — is tested on Linux with no browser. `auth-flow-cdp.test.ts` runs
// the real CDP driver against a real Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AuthRequestError,
  BIND_TIMEOUT_MS,
  ENV_NAME,
  EXPECT_DEFAULT_SECONDS,
  EXPECT_MAX_SECONDS,
  FLOW_VERBS,
  assertCredentialsPresent,
  authAcknowledgement,
  authGate,
  authOptionsFor,
  controlsNamed,
  expectationMet,
  isLoopbackPeer,
  purgeSession,
  readCredential,
  requiredEnvNames,
  retentionFor,
  signIn,
  validateAuthRequest,
} from "./auth-flow.mjs";
import { FLOW_VERBS as CLI_FLOW_VERBS, EXPECT_MAX_SECONDS as CLI_EXPECT_MAX, EXPECT_DEFAULT_SECONDS as CLI_EXPECT_DEFAULT } from "../../cli/src/auth/flows.js";
import { faultCode, FAULT } from "./capture-faults.mjs";

const TOO_MANY = 101; // one over the worker's 100-step bound
const HTTP_FORBIDDEN = 403;
const WAITED_AT_LEAST_MS = 350; // a 400 ms bound, minus scheduling slack
const WAITED_AT_MOST_MS = 2500;
const ORIGIN = "https://app.example.test";
const URL_UNDER_TEST = `${ORIGIN}/orders`;
const FAKE_USER = "canaryuser6d3f2a";
const FAKE_SECRET = "canarysecretb81c94";
const ENV = { APP_USER: FAKE_USER, APP_PASSWORD: FAKE_SECRET };

const expectDashboard = { expect: { kind: "heading", name: "Dashboard", timeoutSeconds: 1 } };
const LOGIN = [
  { goto: "/login" },
  { fill: { field: "Email address", fromEnv: "APP_USER" } },
  { fill: { field: "Password", fromEnv: "APP_PASSWORD" } },
  { press: { control: "Sign in" } },
  expectDashboard,
];

// ---- validation --------------------------------------------------------------------------------------------------

const refused = (auth: unknown, match: RegExp) =>
  assert.throws(() => validateAuthRequest(auth, URL_UNDER_TEST), (e: Error) => {
    assert.ok(e instanceof AuthRequestError, `expected an AuthRequestError, got ${e.name}: ${e.message}`);
    assert.match(e.message, match);
    return true;
  });

test("a valid request is accepted and normalised; upTo defaults to the whole flow", () => {
  const plan = validateAuthRequest({ login: LOGIN, flow: [{ goto: "/cart" }, { capture: "cart" }, { press: { control: "Continue" } }] }, URL_UNDER_TEST);
  assert.equal(plan.login.length, LOGIN.length);
  assert.equal(plan.upTo, 3);
  assert.deepEqual(plan.login[4], expectDashboard);
  assert.deepEqual(plan.flow[2], { press: { control: "Continue" } });
});

test("the closed vocabulary, the origin pin and the login rules are enforced AGAIN at the worker", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["a step outside the vocabulary", { login: [{ script: "document.title" }, expectDashboard] }, /not a step/],
    ["a goto that leaves the origin", { login: [{ goto: "//evil.test/login" }, expectDashboard] }, /leaves/],
    ["a goto to another site", { login: [{ goto: "https://evil.test/" }, expectDashboard] }, /leaves/],
    ["a login literal", { login: [{ fill: { field: "Email", value: "ada@example.test" } }, expectDashboard] }, /fromEnv only/],
    ["a capture inside a login", { login: [{ goto: "/login" }, { capture: "x" }, expectDashboard] }, /captures nothing/],
    ["a login with no final expect", { login: [{ goto: "/login" }, { press: { control: "Sign in" } }] }, /must end with expect/],
    ["an empty login", { login: [] }, /no steps/],
    ["no login at all", { flow: [{ goto: "/x" }] }, /must be a list/],
    ["an unknown key on the request", { login: LOGIN, cookies: "session=1" }, /cookies/],
    ["an unknown key on a step", { login: [{ fill: { field: "Email", fromEnv: "A_B", password: "x" } }, expectDashboard] }, /password/],
    ["a fromEnv that is not a name", { login: [{ fill: { field: "Email", fromEnv: "hunter 2" } }, expectDashboard] }, /NAME/],
    ["an expect with no bound", { login: [{ goto: "/l" }, { expect: { kind: "heading", name: "D", timeoutSeconds: 31 } }] }, /at most/],
    ["an upTo beyond the flow", { login: LOGIN, flow: [{ goto: "/a" }], upTo: 2 }, /upTo/],
    ["too many steps", { login: [...Array(TOO_MANY).fill({ goto: "/x" }), expectDashboard] }, /more than/],
    ["a step with two verbs", { login: [{ goto: "/x", press: "Go" }, expectDashboard] }, /exactly one verb/],
  ];
  for (const [label, auth, match] of bad) {
    try { refused(auth, match); } catch (error) { throw new Error(`${label}: ${(error as Error).message}`, { cause: error }); }
  }
  // A non-login flow may carry a literal (the same file, parsed above), and may capture.
  validateAuthRequest({ login: LOGIN, flow: [{ fill: { field: "Postcode", value: "AB1 2CD" } }, { capture: "here" }] }, URL_UNDER_TEST);
});

test("the constants the worker shares with the CLI's flows.ts are equal, from BOTH sides", () => {
  assert.deepEqual([...FLOW_VERBS], [...CLI_FLOW_VERBS]);
  assert.equal(EXPECT_MAX_SECONDS, CLI_EXPECT_MAX);
  // `ENV_NAME` is not exported by flows.ts, so it is read from its source. The scrape's own guard: it must find one.
  const source = readFileSync(new URL("../../cli/src/auth/flows.ts", import.meta.url), "utf8");
  const scraped = /const ENV_NAME = (\/.+\/);/.exec(source);
  assert.ok(scraped, "flows.ts no longer declares ENV_NAME in the shape this test reads; update it, do not delete it");
  assert.equal(String(ENV_NAME), scraped[1]);
  assert.equal(EXPECT_DEFAULT_SECONDS, CLI_EXPECT_DEFAULT);
});

// ---- the peer gate -----------------------------------------------------------------------------------------------

test("an auth request from a peer that is not this machine is refused 403 auth-refused-remote-worker", () => {
  for (const peer of ["192.0.2.10", "198.51.100.7", "::ffff:192.0.2.10", "2001:db8::1", "", undefined]) {
    const answer = authGate({ auth: { login: [] }, peer });
    assert.equal(answer?.status, HTTP_FORBIDDEN, String(peer));
    assert.equal(answer?.body.fault, "auth-refused-remote-worker");
  }
  for (const peer of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(authGate({ auth: { login: [] }, peer }), null, peer);
    assert.ok(isLoopbackPeer(peer));
  }
  // No auth, no refusal: a remote host is welcome to an unauthenticated capture, as it always was.
  assert.equal(authGate({ auth: undefined, peer: "192.0.2.10" }), null);
});

// ---- the environment ---------------------------------------------------------------------------------------------

test("a variable the plan reads that is missing is found BEFORE anything runs, naming it and never a value", () => {
  const plan = validateAuthRequest({ login: LOGIN, flow: [{ fill: { field: "PIN", fromEnv: "APP_PIN" } }] }, URL_UNDER_TEST);
  assert.deepEqual(requiredEnvNames(plan).sort(), ["APP_PASSWORD", "APP_PIN", "APP_USER"]);
  for (const env of [{ APP_USER: FAKE_USER, APP_PASSWORD: FAKE_SECRET }, { ...ENV, APP_PIN: "" }]) {
    assert.throws(() => assertCredentialsPresent(plan, env), (e: Error) => {
      assert.equal(faultCode(e), FAULT.AUTH_CREDENTIAL_MISSING);
      assert.match(e.message, /APP_PIN/);
      assert.ok(!e.message.includes(FAKE_USER) && !e.message.includes(FAKE_SECRET));
      return true;
    });
  }
  assertCredentialsPresent(plan, { ...ENV, APP_PIN: "12345678" });
  // upTo bounds what is required: a step past the capture point is not run, so its variable is not needed.
  const short = validateAuthRequest({ login: LOGIN, flow: [{ fill: { field: "PIN", fromEnv: "APP_PIN" } }], upTo: 0 }, URL_UNDER_TEST);
  assertCredentialsPresent(short, ENV);
  assert.equal(readCredential("APP_USER", ENV), FAKE_USER);
});

// ---- the interpreter, over a fake browser ------------------------------------------------------------------------

type Ax = { id: string; role: string; name: string; parentId?: string; backendId?: number; ignored: boolean };

/** A tiny site: a login form, a dashboard, an off-origin identity provider, and a form with a password-type PIN. */
function fakeBrowser(options: { password?: string; redirectOnSignIn?: string } = {}) {
  const password = options.password ?? FAKE_SECRET;
  let page = "about:blank";
  let origin = "null";
  const typed: Array<{ field: string; text: string }> = [];
  const clicks: string[] = [];
  const values = new Map<number, string>();
  const nodes = (): Ax[] => {
    let next = 0;
    const node = (role: string, name: string, extra: Partial<Ax> = {}): Ax => {
      next += 1;
      return { id: String(next), role, name, backendId: next, ignored: false, ...extra };
    };
    if (page.endsWith("/login")) {
      return [node("textbox", "Email address"), node("textbox", "Password"), node("button", "Sign in"), node("heading", "Sign in")];
    }
    if (page.endsWith("/dashboard") || page.endsWith("/orders")) {
      return [node("heading", "Dashboard"), node("link", "Sign out")];
    }
    if (page.endsWith("/twins")) {
      const group = node("group", "Billing");
      const other = node("group", "Shipping");
      return [group, other, node("textbox", "Address", { parentId: group.id }), node("textbox", "Address", { parentId: other.id })];
    }
    if (page.endsWith("/pin")) return [node("textbox", "PIN")];
    if (page.endsWith("/prefs")) return [node("checkbox", "Remember me"), node("combobox", "Country")];
    return [];
  };
  const idOf = (handle: number) => nodes().find((n) => n.backendId === handle)!;
  return {
    typed, clicks,
    driver: {
      navigate: async (url: string) => {
        page = url; origin = new URL(url).origin;
        return { ok: !url.endsWith("/down") };
      },
      origin: async () => origin,
      axNodes: async () => nodes(),
      inputType: async (handle: number) => (idOf(handle).name === "PIN" || idOf(handle).name === "Password" ? "password" : "text"),
      fill: async (handle: number, text: string) => { typed.push({ field: idOf(handle).name, text }); values.set(handle, text); },
      choose: async (_handle: number, option: string) => option === "United Kingdom",
      isChecked: async () => false,
      click: async (handle: number) => {
        const target = idOf(handle);
        clicks.push(target.name);
        if (target.name !== "Sign in") return;
        const typedPassword = typed.filter((t) => t.field === "Password").pop()?.text;
        if (options.redirectOnSignIn) { page = `${options.redirectOnSignIn}/authorize`; origin = options.redirectOnSignIn; return; }
        if (typedPassword === password) page = `${ORIGIN}/dashboard`;
      },
      purge: async () => { typed.length = 0; },
      close: async () => undefined,
    },
  };
}

function run(browser: ReturnType<typeof fakeBrowser>, auth: unknown, env: Record<string, string | undefined> = ENV) {
  const marks: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const plan = validateAuthRequest(auth, URL_UNDER_TEST);
  const outcome = signIn({
    plan, url: URL_UNDER_TEST, driver: browser.driver, env, bindTimeoutMs: 250,
    mark: (event, detail) => marks.push({ event, detail }),
  });
  return { outcome, marks };
}

const failsWith = async (outcome: Promise<unknown>, reason: string, match?: RegExp) => {
  await assert.rejects(outcome, (e: Error & { reason?: string }) => {
    assert.equal(faultCode(e), FAULT.AUTH_LOGIN_FAILED, e.message);
    assert.equal(e.reason, reason, e.message);
    if (match) assert.match(e.message, match);
    return true;
  });
};

test("a login runs to the dashboard, types the environment's values, and lands on the requested page", async () => {
  const browser = fakeBrowser();
  const { outcome, marks } = run(browser, { login: LOGIN });
  await outcome;
  assert.deepEqual(browser.typed, [{ field: "Email address", text: FAKE_USER }, { field: "Password", text: FAKE_SECRET }]);
  assert.deepEqual(browser.clicks, ["Sign in"]);
  assert.equal(await browser.driver.origin(), ORIGIN);
  assert.equal(marks[marks.length - 1].event, "authApplied", "the acknowledgement is the LAST thing, after the requested page loaded");
});

test("NOTHING the run records or throws carries a value: marks, errors and the refusal all name steps and controls only", async () => {
  const good = fakeBrowser();
  const okRun = run(good, { login: LOGIN });
  await okRun.outcome;
  const bad = fakeBrowser({ password: "a different password entirely" });
  const badRun = run(bad, { login: LOGIN });
  const error = await badRun.outcome.then(() => null, (e: Error) => e);
  assert.ok(error, "the wrong password must fail the run");
  for (const text of [JSON.stringify(okRun.marks), JSON.stringify(badRun.marks), error!.message]) {
    assert.ok(!text.includes(FAKE_USER) && !text.includes(FAKE_SECRET), text);
  }
  assert.ok(okRun.marks.some((m) => m.event === "authStep" && m.detail.name === "Email address"), "it records WHICH control, by name");
});

test("a wrong password is auth-login-failed expect-not-met, names the step, and is not authApplied", async () => {
  const { outcome, marks } = run(fakeBrowser({ password: "something else" }), { login: LOGIN });
  await failsWith(outcome, "expect-not-met", /login step 5 \(expect\).*no heading "Dashboard"/);
  assert.ok(!marks.some((m) => m.event === "authApplied"));
});

test("a control that cannot be addressed by accessible name is unbindable-field, and says it is a 4.1.2 finding", async () => {
  const login = [{ goto: "/login" }, { fill: { field: "E-mail", fromEnv: "APP_USER" } }, expectDashboard];
  await failsWith(run(fakeBrowser(), { login }).outcome, "unbindable-field", /no control is named "E-mail".*4\.1\.2/s);
});

test("two controls with one name are unbindable until within: or nth: says which", async () => {
  const flow = (fill: object) => ({ login: LOGIN, flow: [{ goto: "/twins" }, { fill }] });
  await failsWith(run(fakeBrowser(), flow({ field: "Address", value: "1 High St" })).outcome, "unbindable-field",
    /2 controls are named "Address"; say which with within or nth/);
  const inBilling = fakeBrowser();
  await run(inBilling, flow({ field: "Address", within: "Billing", value: "1 High St" })).outcome;
  assert.deepEqual(inBilling.typed.pop(), { field: "Address", text: "1 High St" });
  const second = fakeBrowser();
  await run(second, flow({ field: "Address", nth: 2, value: "2 Low Rd" })).outcome;
  assert.deepEqual(second.typed.pop(), { field: "Address", text: "2 Low Rd" });
  await failsWith(run(fakeBrowser(), flow({ field: "Address", nth: 3, value: "x" })).outcome, "unbindable-field");
});

test("a redirect off the origin after a press is left-origin, and SSO is named", async () => {
  await failsWith(run(fakeBrowser({ redirectOnSignIn: "https://idp.example.test" }), { login: LOGIN }).outcome,
    "left-origin", /idp\.example\.test.*SSO.*dedicated test account/s);
});

test("a goto that cannot load ends the run, and so does a requested page that cannot", async () => {
  await failsWith(run(fakeBrowser(), { login: [{ goto: "/down" }, expectDashboard] }).outcome, "expect-not-met", /could not be loaded/);
});

test("A LITERAL TYPED INTO A PASSWORD-TYPE INPUT is auth-literal-secret, in a NON-login flow, and nothing is typed", async () => {
  const browser = fakeBrowser();
  const { outcome } = run(browser, { login: LOGIN, flow: [{ goto: "/pin" }, { fill: { field: "PIN", value: "1234" } }] });
  await assert.rejects(outcome, (e: Error) => {
    assert.equal(faultCode(e), FAULT.AUTH_LITERAL_SECRET);
    assert.match(e.message, /"PIN"/);
    assert.ok(!e.message.includes("1234"));
    return true;
  });
  assert.ok(!browser.typed.some((t) => t.field === "PIN"), "the literal must never have reached the page");
  // The control: a from-env value into the same password input is fine, and a literal into a text input is fine.
  const ok = fakeBrowser();
  await run(ok, { login: LOGIN, flow: [{ goto: "/pin" }, { fill: { field: "PIN", fromEnv: "APP_USER" } }] }).outcome;
});

test("the flow is replayed to upTo and no further, and a capture step acts on nothing", async () => {
  const browser = fakeBrowser();
  const { outcome } = run(browser, {
    login: LOGIN,
    flow: [{ goto: "/pin" }, { capture: "before" }, { fill: { field: "PIN", fromEnv: "APP_USER" } }],
    upTo: 2,
  });
  await outcome;
  assert.ok(!browser.typed.some((t) => t.field === "PIN"), "the step after the capture point must not have run");
});

test("choose and check bind by accessible name and act", async () => {
  const browser = fakeBrowser();
  await run(browser, { login: LOGIN, flow: [
    { goto: "/prefs" }, { check: { field: "Remember me" } }, { choose: { field: "Country", option: "United Kingdom" } },
  ] }).outcome;
  assert.ok(browser.clicks.includes("Remember me"));
  await failsWith(run(fakeBrowser(), { login: LOGIN, flow: [{ goto: "/prefs" }, { choose: { field: "Country", option: "Atlantis" } }] }).outcome,
    "unbindable-field", /no option "Atlantis"/);
});

test("expect WAITS for its condition and gives up at its bound, not before and not long after", async () => {
  const startedAt = Date.now();
  await failsWith(run(fakeBrowser({ password: "nope" }), { login: [...LOGIN.slice(0, 4), { expect: { kind: "heading", name: "Dashboard", timeoutSeconds: 0.4 } }] }).outcome,
    "expect-not-met");
  const took = Date.now() - startedAt;
  assert.ok(took >= WAITED_AT_LEAST_MS && took < WAITED_AT_MOST_MS, `waited ${took} ms for a 400 ms bound`);
  assert.ok(BIND_TIMEOUT_MS > 0);
});

test("the matching functions: by name, by role, within a named ancestor, and expectations of three kinds", () => {
  const nodes: Ax[] = [
    { id: "1", role: "group", name: "Billing", ignored: false },
    { id: "2", role: "textbox", name: "  Address\n line ", parentId: "1", backendId: 2, ignored: false },
    { id: "3", role: "textbox", name: "Address line", backendId: 3, ignored: false },
    { id: "4", role: "textbox", name: "Address line", backendId: 4, ignored: true },
    { id: "5", role: "heading", name: "Dashboard", ignored: false },
  ];
  assert.equal(controlsNamed(nodes, { roles: ["textbox"], name: "Address line" }).length, 2, "whitespace-normalised; ignored nodes excluded");
  assert.deepEqual(controlsNamed(nodes, { roles: ["textbox"], name: "Address line", within: "Billing" }).map((n) => n.id), ["2"]);
  assert.equal(controlsNamed(nodes, { roles: ["button"], name: "Address line" }).length, 0);
  assert.ok(expectationMet(nodes, { kind: "heading", name: "Dashboard" }));
  assert.ok(!expectationMet(nodes, { kind: "heading", name: "Address line" }), "a textbox is not a heading");
  assert.ok(expectationMet(nodes, { kind: "control", name: "Address line" }));
  assert.ok(expectationMet(nodes, { kind: "text", name: "Dash" }));
});

test("purgeSession clears the ORIGIN of the requested page", async () => {
  const seen: string[] = [];
  await purgeSession({ purge: async (origin: string) => { seen.push(origin); } } as never, "https://app.example.test:8443/a/b?c=d");
  assert.deepEqual(seen, ["https://app.example.test:8443"]);
});

// ---- the decisions server.mjs would otherwise make inline (it needs a screen reader to import, so it has no test) ----

test("an authenticated request FORCES reuseBrowser off, whatever the request or the fleet default says", () => {
  const parsed = { url: URL_UNDER_TEST, auth: { login: LOGIN }, reuseBrowser: true };
  const options = authOptionsFor({ parsed, env: ENV });
  assert.equal(options.reuseBrowser, false);
  assert.equal(options.auth?.login.length, LOGIN.length);
  // The control: with no auth the function contributes NOTHING, so an ordinary request keeps whatever it asked for.
  assert.deepEqual(authOptionsFor({ parsed: { url: URL_UNDER_TEST }, env: ENV }), {});
});

test("authOptionsFor validates again and checks the environment before anything launches", () => {
  assert.throws(() => authOptionsFor({ parsed: { url: URL_UNDER_TEST, auth: { login: [{ script: "x" }] } }, env: ENV }), AuthRequestError);
  assert.throws(() => authOptionsFor({ parsed: { url: URL_UNDER_TEST, auth: { login: LOGIN } }, env: { APP_USER: FAKE_USER } }),
    (e: Error) => faultCode(e) === FAULT.AUTH_CREDENTIAL_MISSING && /APP_PASSWORD/.test(e.message));
});

test("authApplied is acknowledged only after the sign-in ran to its end, and only for an authenticated capture", () => {
  const plan = validateAuthRequest({ login: LOGIN }, URL_UNDER_TEST);
  assert.deepEqual(authAcknowledgement({ auth: plan, marks: [{ event: "authStep" }, { event: "authApplied" }] }), { authApplied: true });
  assert.deepEqual(authAcknowledgement({ auth: plan, marks: [{ event: "authStep" }] }), {}, "a login that never finished says nothing");
  assert.deepEqual(authAcknowledgement({ auth: undefined, marks: [{ event: "authApplied" }] }), {}, "no auth, no acknowledgement");
});

test("an authenticated capture's response is kept for one delivery; an ordinary one is not", () => {
  assert.deepEqual(retentionFor({ auth: validateAuthRequest({ login: LOGIN }, URL_UNDER_TEST) }), { deliverOnce: true });
  assert.deepEqual(retentionFor({}), { deliverOnce: false });
});
