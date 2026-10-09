// THE DIAGNOSTIC SWITCH THAT LETS A RUN SKIP THE POST-LOGIN "WINDOW NAVIGATED" MARK (a11y-witness #4111, #4084 outcome 1, prerequisite of #4107).
//
// `A11Y_DIAG_SKIP_LOGIN_MARK=1` in the worker process's environment makes `signInIfAsked` hand `beginAuthentication` a `markNavigated` that
// only records `loginMarkSuppressed`. Every other value, or none, changes nothing. These tests drive the REAL `beginAuthentication` on a fake
// driver with the override `capture-core.ts` builds, so the switch is observed at the seam it acts on; the call site's use of the override
// is READ FROM SOURCE (comments stripped), because `signInIfAsked` is private and its driver is a real Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripComments } from "@a11ign/evidence/source-text";

import { validateAuthRequest } from "./auth-flow.ts";
import { beginAuthentication } from "./capture-auth.ts";
import { loginMarkOverride } from "./capture-core.ts";

const APP = "https://app.example.test";
const ACCOUNT_URL = `${APP}/account`;
const SWITCH = "A11Y_DIAG_SKIP_LOGIN_MARK";

/** A page that is already the signed-in Account page: the smallest login (one `goto`, one `expect`) that completes on a fake driver. */
function accountDriver() {
  return {
    navigate: async () => ({ ok: true }),
    origin: async () => APP,
    url: async () => ACCOUNT_URL,
    axNodes: async () => [{ id: "1", role: "heading", name: "Account", backendId: 1, ignored: false }],
    frameSources: async () => [],
    inputType: async () => "text",
    fill: async () => undefined,
    choose: async () => false,
    isChecked: async () => false,
    click: async () => undefined,
    setCookies: async () => undefined,
    setLocalStorage: async () => undefined,
    purge: async () => undefined,
    close: async () => undefined,
  };
}

// `idpOrigins` is declared so a login that ends ON the requested page is not loaded again: the fake needs no `land`, and no Chromium is asked for.
const PLAN = () => validateAuthRequest({ login: [{ goto: "/login" }, { expect: { kind: "heading", name: "Account", timeoutSeconds: 1 } }], idpOrigins: ["https://idp.example.test"] }, ACCOUNT_URL);

const recordingDiag = (events: string[]) => ({ entries: [], sinceStart: () => 0, mark: (event: string) => { events.push(event); } });

/** One login with the override for `env`; `marked` counts the calls of whatever `markNavigated` the login was given AFTER the override wrapped it. */
async function loginWith(env: Record<string, string | undefined>) {
  const events: string[] = [];
  const diag = recordingDiag(events);
  const override = loginMarkOverride({ diag, env });
  let realMarks = 0;
  // When the override says nothing, the login must use ITS OWN default (the real mark); a spy stands in only to count that default being reached.
  const markNavigated = override.markNavigated ?? (() => { realMarks += 1; });
  await beginAuthentication({ plan: PLAN(), url: ACCOUNT_URL, diag, env: {}, openDriver: async () => accountDriver() as never, markNavigated });
  return { events, realMarks, overridden: override.markNavigated !== undefined };
}

test(`${SWITCH}=1: the login ends WITHOUT the real mark, and the diag says the mark was suppressed`, async () => {
  const outcome = await loginWith({ [SWITCH]: "1" });
  assert.equal(outcome.overridden, true);
  assert.equal(outcome.realMarks, 0);
  assert.ok(outcome.events.includes("loginMarkSuppressed"), `diag events: ${outcome.events.join(",")}`);
});

for (const [label, env] of [["unset", {}], ["0", { [SWITCH]: "0" }], ["empty", { [SWITCH]: "" }], ["true", { [SWITCH]: "true" }]] as const) {
  test(`CONTROL: ${SWITCH} ${label} leaves the mark exactly as today, and records nothing`, async () => {
    const outcome = await loginWith(env);
    assert.equal(outcome.overridden, false);
    assert.equal(outcome.realMarks, 1);
    assert.ok(!outcome.events.includes("loginMarkSuppressed"));
  });
}

test("the real default is what runs when the override is silent: beginAuthentication is given NO markNavigated", () => {
  assert.deepEqual(loginMarkOverride({ diag: recordingDiag([]), env: {} }), {});
});

test("the capture's call site passes the override, and nothing else can reach the switch", () => {
  const core = stripComments(readFileSync(resolve(import.meta.dirname, "capture-core.ts"), "utf8"));
  assert.match(core, /beginAuthentication\(\{[^}]*\.\.\.loginMarkOverride\(\{ diag \}\)/);
  const protocol = readFileSync(resolve(import.meta.dirname, "auth-flow.ts"), "utf8");
  assert.ok(!protocol.includes(SWITCH), "the request protocol's validator must not know the switch");
});
