// THE WORKER-LOCAL AUTHENTICATED CAPTURE (a11y-witness #4171, #4084 outcome 1, prerequisite of #4107).
//
// `node capture.ts <url> <outFile> [steps] --auth <plan.json>` runs on the worker's own machine, reads the plan's `fromEnv` credentials from THAT
// process's environment, and prints the heading NVDA announced. These tests drive `runLocalCapture` on a fake `captureWithNvda`, so no browser,
// NVDA or worker is touched. Two controls: the plan reaches the capture as `auth` (unfixed, none does and the login never happens), and a missing
// variable stops the run before the capture is called (unfixed, an empty credential would be submitted).
import { test } from "node:test";
import assert from "node:assert/strict";

import { runLocalCapture } from "./capture.ts";

const URL_ = "http://127.0.0.1:5050/";
const PLAN_FILE = "/plans/login.json";
const OUT_FILE = "/out/transcript.json";
const SWITCH = "A11Y_DIAG_SKIP_LOGIN_MARK";
const BOTH = { IDP_USER: "fake@example.test", IDP_PASSWORD: "fake-password-1" };

const PLAN = {
  login: [
    { goto: "/login" },
    { fill: { field: "Email", fromEnv: "IDP_USER" } },
    { fill: { field: "Password", fromEnv: "IDP_PASSWORD" } },
    { press: { control: "Sign in" } },
    { expect: { kind: "heading", name: "Account", timeoutSeconds: 5 } },
  ],
  idpOrigins: ["http://127.0.0.1:5051"],
};

type Opts = { steps?: number; reuseBrowser?: boolean; auth?: { login: unknown[]; idpOrigins?: string[] } };
type Seen = { url: string; opts: Opts }[];

/** One run on fakes: the plan file is `PLAN`, and `transcript` is what the fake NVDA "announced". */
async function run({ argv, env, transcript = ["Account  heading  level 1", "Signed in"] }: { argv: string[]; env: Record<string, string>; transcript?: string[] }) {
  const seen: Seen = [];
  const lines: string[] = [];
  const written: { path: string; text: string }[] = [];
  const outcome = await runLocalCapture({
    argv,
    env,
    capture: async (url: string, opts: Opts) => { seen.push({ url, opts }); return { transcript }; },
    readText: (path: string) => { assert.equal(path, PLAN_FILE); return JSON.stringify(PLAN); },
    writeText: (path: string, text: string) => { written.push({ path, text }); },
    log: (line: string) => { lines.push(line); },
  }).then(() => null, (error: Error) => error);
  return { seen, lines, written, outcome };
}

const argv = [URL_, OUT_FILE, "40", "--auth", PLAN_FILE];

test("with a login plan and both variables set, the plan reaches the capture as `auth` and the announced heading is printed", async () => {
  const { seen, lines, outcome } = await run({ argv, env: BOTH });
  assert.equal(outcome, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, URL_);
  assert.equal(seen[0].opts.steps, 40);
  assert.equal(seen[0].opts.auth!.login.length, PLAN.login.length);
  assert.deepEqual(seen[0].opts.auth!.login[1], { fill: { field: "Email", fromEnv: "IDP_USER" } });
  assert.deepEqual(seen[0].opts.auth!.idpOrigins, ["http://127.0.0.1:5051"]);
  assert.equal(seen[0].opts.reuseBrowser, false, "a signed-in browser is never kept for the next capture");
  assert.ok(lines.some((line) => line.includes("Account  heading  level 1")), `printed: ${lines.join(" | ")}`);
});

test("CONTROL: no --auth is the capture this file always was, with no `auth` and no login", async () => {
  const { seen, outcome } = await run({ argv: [URL_, OUT_FILE, "40"], env: {} });
  assert.equal(outcome, null);
  assert.equal(seen.length, 1);
  assert.ok(!("auth" in seen[0].opts), "an unauthenticated capture must not carry an auth key");
});

for (const missing of ["IDP_USER", "IDP_PASSWORD"]) {
  test(`${missing} not set: stops with a sentence naming it, calls nothing and writes nothing`, async () => {
    const env: Record<string, string> = { ...BOTH };
    delete env[missing];
    const { seen, written, lines, outcome } = await run({ argv, env });
    assert.ok(outcome instanceof Error, "the run must refuse");
    assert.match(outcome.message, new RegExp(missing));
    assert.equal(seen.length, 0, "the capture must not be called");
    assert.equal(written.length, 0);
    assert.ok(!lines.some((line) => line.includes(BOTH.IDP_USER) || line.includes(BOTH.IDP_PASSWORD)));
  });
}

test("CONTROL: a variable that is set but EMPTY is as missing as an absent one", async () => {
  const { seen, outcome } = await run({ argv, env: { ...BOTH, IDP_PASSWORD: "" } });
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /IDP_PASSWORD/);
  assert.equal(seen.length, 0);
});

test("a credential value is never printed, and the refusal for a missing one quotes no value", async () => {
  const { lines, outcome } = await run({ argv, env: BOTH });
  assert.equal(outcome, null);
  for (const value of Object.values(BOTH)) assert.ok(!lines.join("\n").includes(value));
  const refused = await run({ argv, env: { IDP_USER: BOTH.IDP_USER } });
  assert.ok(!String((refused.outcome as Error).message).includes(BOTH.IDP_USER));
});

test("the heading line is found whatever phrase it is, and its absence is its own line, not a blank", async () => {
  const none = await run({ argv, env: BOTH, transcript: ["Signed in", "link  Sign out"] });
  assert.ok(none.lines.some((line) => /no heading announced/i.test(line) && line.includes("2")), `printed: ${none.lines.join(" | ")}`);
  const later = await run({ argv, env: BOTH, transcript: ["Signed in", "heading  level 1  Account"] });
  assert.ok(later.lines.some((line) => line.includes("heading  level 1  Account")));
});

for (const [label, env, set] of [["1", { [SWITCH]: "1" }, true], ["unset", {}, false], ["0", { [SWITCH]: "0" }, false], ["empty", { [SWITCH]: "" }, false]] as const) {
  test(`${SWITCH} ${label}: the transcript says the switch is ${set ? "SET, so the run is the control" : "not set"}`, async () => {
    const { lines } = await run({ argv, env: { ...BOTH, ...env } });
    const line = lines.find((text) => text.includes(SWITCH));
    assert.ok(line, `no line names ${SWITCH}: ${lines.join(" | ")}`);
    assert.equal(/\bset\b/i.test(line.replace(/not set/i, "")), set, line);
  });
}

test("the switch line is printed BEFORE the capture runs, so a failed run still says which run it was", async () => {
  const lines: string[] = [];
  await runLocalCapture({
    argv, env: { ...BOTH, [SWITCH]: "1" }, readText: () => JSON.stringify(PLAN), writeText: () => undefined,
    capture: async () => { throw new Error("NVDA did not start"); }, log: (line: string) => { lines.push(line); },
  }).catch(() => undefined);
  assert.ok(lines.some((line) => line.includes(SWITCH)));
});

test("a plan that is not the wire shape is refused by the worker's own validator, before the capture", async () => {
  const seen: unknown[] = [];
  const outcome = await runLocalCapture({
    argv, env: BOTH, readText: () => JSON.stringify({ login: [{ fill: { field: "Email", value: "a@b.test" } }, { expect: { kind: "heading", name: "A" } }] }),
    writeText: () => undefined, capture: async (...args: unknown[]) => { seen.push(args); return { transcript: [] }; }, log: () => undefined,
  }).then(() => null, (error: Error) => error);
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /fromEnv/);
  assert.equal(seen.length, 0);
});

test("a plan file that is not JSON says so without quoting it", async () => {
  const outcome = await runLocalCapture({
    argv, env: BOTH, readText: () => "{ password: hunter2", writeText: () => undefined, capture: async () => ({ transcript: [] }), log: () => undefined,
  }).then(() => null, (error: Error) => error);
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /not JSON/);
  assert.ok(!outcome.message.includes("hunter2"));
});
