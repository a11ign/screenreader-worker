/**
 * The worker's half of an authenticated capture — ADR 0038, clauses 1, 3 and 4, and amendment 4.
 *
 * A capture request may carry `auth: { login, flow?, upTo?, state? }`: named steps whose secrets are environment-variable
 * NAMES (`fromEnv`), never values. **This worker reads those variables from its own process environment**, logs in
 * to the page through the browser protocol, replays the requested flow to the capture point, and only then does
 * the capture proper begin. Nothing about a login crosses the wire but the steps and the names, and nothing
 * derived from a session ever leaves this process: the session is destroyed after the capture (`purgeSession`).
 *
 * **`loginBlock` (a11ign#4998, #4084 v3 login phase 2) stands in for `login`'s steps**: the request names the login page, THREE
 * environment-variable NAMES (username, password, authenticator secret), a signed-in check and optionally an organization, and this
 * process runs `screen-loop.ts` against the page: it recognises each screen by accessible name and acts on exactly one match. It is the
 * worker's copy of the CLI's loop, and it validates the block again because the block arrives over HTTP from anywhere.
 *
 * **`state: { path }` (ADR 0038, amendment 7) loads a storage state the PERSON saved instead of performing the login.** The
 * request carries a path and nothing else; THIS process reads the file and validates it (`loadStateEntries`), so a request
 * cannot make it load a value the CLI did not show it. The file is a credential: no error here quotes any part of it.
 *
 * Why it is written over a DRIVER (`AuthDriver`) and not over CDP calls directly: the same interpreter is meant
 * to run in the CLI over Playwright for the rule layer (PR 5), and the leak the ADR is about is the interpreter's
 * decisions (what it refuses, what it says, what it never records), not the transport's. The CDP driver at the
 * bottom is the one this worker uses, and `auth-flow-cdp.test.ts` runs it against a real Chromium.
 *
 * **Text goes in through the protocol's text insertion (`Input.insertText`)**, which produces no key events. The
 * transcript does not begin until the login has ended and the page has settled (Constraint 4, the first defence).
 * Whether NVDA speaks text inserted that way is UNMEASURED; NVDA's typed-character default is ON
 * (`/diagnostics.screenReaderDefaults.keyboard.speakTypedCharacters` = `1`, read 2026-09-24 on a11y-worker-3), which
 * is exactly why the CLI's scrub and its per-character detector exist and why this file never treats "not spoken"
 * as established.
 *
 * NEVER RECORDS A VALUE. Every mark, log line and error here names a step, a verb and an ACCESSIBLE NAME, and no
 * value read from the environment or typed into a control: the marks are echoed by `/progress` and returned in
 * error bodies, so a value in one is a value on the wire.
 *
 * DUPLICATED FROM `packages/cli/src/auth/flows.ts`, deliberately: the worker is plain `.mjs` with no build step
 * (ADR 0031) and is not a dependency of the CLI, so it cannot import the schema, and it must not trust the CLI to
 * have validated (a request reaches this port from anywhere). `auth-flow.test.ts` pins the shared constants and a
 * table of refusals equal to the CLI's.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { CDP_READY_TIMEOUT_MS } from "./browser-session.ts";
import { captureFault, FAULT, faultCode } from "./capture-faults.ts";
import { parseTotpSecret } from "./otpauth.ts";
import type { TotpSecret } from "./otpauth.ts";
import { classifyScreen, runLoop } from "./screen-loop.ts";
import type { Action, FieldSource, LoginOutcome, LoopResult, ScreenControl, ScreenObservation, TypeAction } from "./screen-loop.ts";
import { codeForUse, TotpSeedError } from "./totp.ts";

// JSON from the browser or the page (a CDP reply, a `page.evaluate` result, a request body): its shape is the other end's, and
// modelling it is a job of its own. Named once here so the boundary is greppable and `no-explicit-any` still bites everywhere else.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Untyped = any;

/**
 * The verbs the worker runs. `flows.ts` has one more, `auto`, which the worker refuses BY NAME (see `verbStep`): it hands the screen
 * to a loop the worker runs only for `auth.loginBlock`. Nothing here pins this list to `flows.ts`'s; that parity test is in the lab.
 */
export const FLOW_VERBS = ["goto", "fill", "choose", "check", "press", "expect", "capture", "dismiss-if-shown"];
/** Keys a step may carry BESIDE its verb. They say whether the step runs, never what it does. Same as `flows.ts`'s. */
const STEP_MODIFIERS = ["when", "optional"];
/** The verbs a modifier is refused on, as `flows.ts` refuses them. A condition on a `capture` would move its index. */
const WHEN_REFUSED_ON = ["capture", "dismiss-if-shown"];
const OPTIONAL_ALLOWED_ON = ["fill", "choose", "check", "press", "expect"];
export const EXPECT_DEFAULT_SECONDS = 10;
export const EXPECT_MAX_SECONDS = 30;
/** What a variable NAME may look like. A value is never checked against this: only names are on the wire. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** More steps than any real login or checkout is a request that is not one. */
const MAX_STEPS = 100;
/** How long a control may take to appear before it is `unbindable-field`. A bound, never a sleep. */
export const BIND_TIMEOUT_MS = 10_000;
const POLL_MS = 150;
const MS_PER_SECOND = 1000;
const NAVIGATE_TIMEOUT_MS = 30_000;
const CDP_CALL_TIMEOUT_MS = 15_000;
const CDP_HOST = "127.0.0.1";

type ControlRef = { field: string, within?: string, nth?: number };
type ControlTarget = { control: string, within?: string, nth?: number };
type PageCondition = { kind: "heading" | "control" | "text", name: string };
type StepBody = { goto: string }
  | { fill: ControlRef & { value?: string, fromEnv?: string } }
  | { choose: ControlRef & { option: string } }
  | { check: ControlRef & { checked: boolean } }
  | { press: ControlTarget }
  | { expect: PageCondition & { timeoutSeconds: number } }
  | { "dismiss-if-shown": ControlTarget }
  | { capture: string };
/** A verb, with the modifiers the CLI writes beside it: `when:` skips the step when its condition is not on the page; `optional:` when its control never appears. */
type Step = StepBody & { when?: PageCondition, optional?: true };

type StateCookie = { name: string, value: string, domain: string, path?: string, expires?: number, httpOnly?: boolean, secure?: boolean, sameSite?: string };

type StateEntries = { cookies: (StateCookie & { place: number })[], localStorage: { place: number, name: string, value: string }[] };

/** The adopter's proof of signed-in: an element by ARIA role and accessible name, or a URL path prefix on the app's origin. */
export type SignedInCheck = { role: string, name: string } | { url: string };

/** `auth.loginBlock` after validation. Every `*Env` is the NAME of a variable in THIS process's environment, never a value. */
export type LoginBlockPlan = { url: string, usernameEnv: string, passwordEnv: string, totpEnv: string, check: SignedInCheck, organization?: string };

/** With `loginBlock`, `login` is empty and the screen loop signs in; without it `login` is the steps, as it always was. */
export type AuthPlan = { login: Step[], loginBlock?: LoginBlockPlan, flow: Step[], upTo: number, state?: { path: string, entries?: StateEntries }, idpOrigins?: string[] };

/** A request the worker refuses to act on: a 400, not a capture. Carries no value, because none was read yet. */
export class AuthRequestError extends Error {
  /** @param {string} message */
  constructor(message: string) {
    super(message);
    this.name = "AuthRequestError";
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const isName = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * @param {Record<string, unknown>} entry @param {string[]} allowed @param {string} where
 */
function refuseUnknownKeys(entry: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) throw new AuthRequestError(`${where} has ${key}, which the worker does not define`);
  }
}

/** @param {Record<string, unknown>} entry @param {string} where @returns {ControlRef} */
function controlRef(entry: Record<string, unknown>, where: string): ControlRef {
  if (!isName(entry.field)) throw new AuthRequestError(`${where} has no field name`);
  if (entry.within !== undefined && !isName(entry.within)) throw new AuthRequestError(`${where}: within must be a name`);
  if (entry.nth !== undefined && (!Number.isInteger(entry.nth) || (entry.nth as number) < 1)) {
    throw new AuthRequestError(`${where}: nth counts from 1`);
  }
  return {
    field: entry.field,
    ...(entry.within === undefined ? {} : { within: (entry.within as string) }),
    ...(entry.nth === undefined ? {} : { nth: (entry.nth as number) }),
  };
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function fillStep(raw: unknown, where: string): Step {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: fill takes a mapping`);
  refuseUnknownKeys(raw, ["field", "within", "nth", "value", "fromEnv"], `${where}: fill`);
  const ref = controlRef(raw, `${where}: fill`);
  const given = ["value", "fromEnv"].filter((key) => raw[key] !== undefined);
  if (given.length !== 1) throw new AuthRequestError(`${where}: fill on "${ref.field}" needs exactly one of value or fromEnv`);
  if (raw.fromEnv !== undefined) {
    if (typeof raw.fromEnv !== "string" || !ENV_NAME.test(raw.fromEnv)) {
      throw new AuthRequestError(`${where}: fromEnv on "${ref.field}" must be the NAME of an environment variable`);
    }
    return { fill: { ...ref, fromEnv: raw.fromEnv } };
  }
  if (typeof raw.value !== "string") throw new AuthRequestError(`${where}: value on "${ref.field}" must be text`);
  return { fill: { ...ref, value: raw.value } };
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function expectStep(raw: unknown, where: string): Step {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: expect takes a mapping`);
  refuseUnknownKeys(raw, ["kind", "name", "timeoutSeconds"], `${where}: expect`);
  const kind = raw.kind;
  if (kind !== "heading" && kind !== "control" && kind !== "text") throw new AuthRequestError(`${where}: expect kind`);
  if (!isName(raw.name)) throw new AuthRequestError(`${where}: expect needs a name`);
  const seconds = raw.timeoutSeconds ?? EXPECT_DEFAULT_SECONDS;
  if (typeof seconds !== "number" || !(seconds > 0) || seconds > EXPECT_MAX_SECONDS) {
    throw new AuthRequestError(`${where}: expect waits at most ${EXPECT_MAX_SECONDS} seconds`);
  }
  return { expect: { kind, name: raw.name, timeoutSeconds: seconds } };
}

/**
 * One step: exactly one verb, and whatever modifiers the CLI writes beside it.
 * @param {unknown} raw @param {string} origin @param {string} where @returns {Step}
 */
function validateStep(raw: unknown, origin: string, where: string): Step {
  if (!isObject(raw)) throw new AuthRequestError(`${where} must be a mapping with exactly one verb`);
  const verbs = Object.keys(raw).filter((key) => !STEP_MODIFIERS.includes(key));
  if (verbs.length !== 1) throw new AuthRequestError(`${where} must be a mapping with exactly one verb`);
  const [verb] = verbs;
  return withModifiers(verbStep(verb, raw[verb], origin, where), raw, where);
}

/** @param {string} verb @param {unknown} body @param {string} origin @param {string} where @returns {StepBody} */
function verbStep(verb: string, body: unknown, origin: string, where: string): StepBody {
  switch (verb) {
    case "goto": return { goto: gotoTarget(body, origin, where) };
    case "fill": return fillStep(body, where);
    case "choose": return chooseStep(body, where);
    case "check": return checkStep(body, where);
    case "press": return pressStep(body, where);
    case "expect": return expectStep(body, where);
    case "dismiss-if-shown": return { "dismiss-if-shown": controlTarget(body, "dismiss-if-shown", where) };
    case "capture":
      if (!isName(body)) throw new AuthRequestError(`${where}: capture needs a name`);
      return { capture: body };
    // Refused by name, not as "not a step": a flow that writes auto: is asking for something the worker does not do, and says what.
    case "auto":
      throw new AuthRequestError(`${where}: auto: is refused by the worker. It hands the screen to the CLI's built-in login loop, which the `
        + "worker runs only for auth.loginBlock, so a flow cannot ask for it.");
    default: throw new AuthRequestError(`${where}: ${verb} is not a step; the vocabulary is closed`);
  }
}

/**
 * `when:` and `optional:` as the CLI writes them on the wire, each refused on the verbs `flows.ts` refuses it on.
 * @param {StepBody} step @param {Record<string, unknown>} raw @param {string} where @returns {Step}
 */
function withModifiers(step: StepBody, raw: Record<string, unknown>, where: string): Step {
  const verb = Object.keys(step)[0];
  const modified: Step = { ...step };
  if (raw.when !== undefined) {
    if (WHEN_REFUSED_ON.includes(verb)) throw new AuthRequestError(`${where}: ${verb} does not take when:`);
    modified.when = pageCondition(raw.when, where);
  }
  if (raw.optional !== undefined) {
    if (!OPTIONAL_ALLOWED_ON.includes(verb)) {
      throw new AuthRequestError(`${where}: ${verb} does not take optional:, since it has no control that could be missing`);
    }
    if (raw.optional !== true) throw new AuthRequestError(`${where}: optional is written true, and takes nothing else`);
    modified.optional = true;
  }
  return modified;
}

/**
 * A page condition as the CLI writes it, `{ kind, name }`. `when:` reads the page once and never waits, so a `timeout` on it is refused.
 * @param {unknown} raw @param {string} where @returns {PageCondition}
 */
function pageCondition(raw: unknown, where: string): PageCondition {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: when takes a mapping of kind and name`);
  if (raw.timeout !== undefined || raw.timeoutSeconds !== undefined) {
    throw new AuthRequestError(`${where}: when takes no timeout. It looks at the page once and never waits; use expect for a wait`);
  }
  refuseUnknownKeys(raw, ["kind", "name"], `${where}: when`);
  const { kind, name } = raw;
  if (kind !== "heading" && kind !== "control" && kind !== "text") throw new AuthRequestError(`${where}: when kind`);
  if (!isName(name)) throw new AuthRequestError(`${where}: when needs a name`);
  return { kind, name };
}

/** @param {unknown} body @param {string} origin @param {string} where */
function gotoTarget(body: unknown, origin: string, where: string) {
  if (!isName(body)) throw new AuthRequestError(`${where}: goto needs a path`);
  let resolved;
  try { resolved = new URL(body, origin); } catch { resolved = null; }
  // Resolved and compared by parsed origin, never by prefix: `//evil.test/x` begins like the origin and leaves it.
  if (resolved === null || resolved.origin !== origin) throw new AuthRequestError(`${where}: goto leaves ${origin}`);
  return body;
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function chooseStep(raw: unknown, where: string): Step {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: choose takes a mapping`);
  refuseUnknownKeys(raw, ["field", "within", "nth", "option"], `${where}: choose`);
  const ref = controlRef(raw, `${where}: choose`);
  if (!isName(raw.option)) throw new AuthRequestError(`${where}: choose on "${ref.field}" has no option`);
  return { choose: { ...ref, option: raw.option } };
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function checkStep(raw: unknown, where: string): Step {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: check takes a mapping`);
  refuseUnknownKeys(raw, ["field", "within", "nth", "checked"], `${where}: check`);
  const ref = controlRef(raw, `${where}: check`);
  if (raw.checked !== undefined && typeof raw.checked !== "boolean") throw new AuthRequestError(`${where}: checked is a boolean`);
  return { check: { ...ref, checked: raw.checked !== false } };
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function pressStep(raw: unknown, where: string): Step {
  return { press: controlTarget(raw, "press", where) };
}

/** `press:` and `dismiss-if-shown:` name a control by its accessible name, with `within:` and `nth:` to say which. */
function controlTarget(raw: unknown, verb: string, where: string): ControlTarget {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: ${verb} takes a mapping`);
  refuseUnknownKeys(raw, ["control", "within", "nth"], `${where}: ${verb}`);
  const { field, ...rest } = controlRef({ ...raw, field: raw.control }, `${where}: ${verb}`);
  return { control: field, ...rest };
}

/**
 * @param {unknown} steps @param {string} origin @param {string} label
 * @returns {Step[]}
 */
function validateSteps(steps: unknown, origin: string, label: string): Step[] {
  if (!Array.isArray(steps)) throw new AuthRequestError(`auth.${label} must be a list of steps`);
  if (steps.length > MAX_STEPS) throw new AuthRequestError(`auth.${label} has more than ${MAX_STEPS} steps`);
  return steps.map((step, index) => validateStep(step, origin, `auth.${label} step ${index + 1}`));
}

/**
 * The login's STEPS, held to the rules a login is held to in `flows.ts`: `fromEnv` only (a literal in a login is a password committed
 * to somebody's file), ends in `expect`, captures nothing.
 * @param {unknown} raw @param {string} origin @returns {Step[]}
 */
function validateLoginSteps(raw: unknown, origin: string): Step[] {
  const login = validateSteps(raw, origin, "login");
  if (login.length === 0) throw new AuthRequestError("auth.login has no steps");
  login.forEach((step, index) => {
    const where = `auth.login step ${index + 1}`;
    if ("fill" in step && step.fill.fromEnv === undefined) {
      throw new AuthRequestError(`${where}: a login's fill takes fromEnv only, never a literal`);
    }
    if ("capture" in step) throw new AuthRequestError(`${where}: a login captures nothing`);
  });
  const last = login[login.length - 1];
  if (!("expect" in last)) throw new AuthRequestError("auth.login must end with expect");
  // The CLI's rule, `resolveLoginFlow`: a post-condition that can be skipped is no post-condition, so the login's last step always runs.
  if (last.when !== undefined) throw new AuthRequestError("auth.login ends with an expect: that carries when:, so the login's last step always runs");
  return login;
}

const LOGIN_BLOCK_KEYS = ["url", "usernameEnv", "passwordEnv", "totpEnv", "check", "organization"];

/**
 * A variable NAME, and never echoed: a request that put a value where a name belongs may have put a password there, and a refusal is a
 * log line. Letters, digits and underscores only, so a literal with a space, a symbol or a leading digit is refused here.
 * @param {unknown} value @param {string} where
 */
function envNameOf(value: unknown, where: string): string {
  if (typeof value !== "string" || !ENV_NAME.test(value)) {
    throw new AuthRequestError(`${where} must be the NAME of an environment variable (letters, digits and underscores); a value is never sent`);
  }
  return value;
}

/** `loginBlock.url`: the login page, on the capture URL's own origin; an identity provider is reached by redirect and `idpOrigins`. */
function loginBlockUrl(value: unknown, origin: string): string {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new AuthRequestError("auth.loginBlock.url must be an absolute http or https URL"); }
  if (typeof value !== "string" || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new AuthRequestError("auth.loginBlock.url must be an absolute http or https URL");
  }
  if (parsed.username !== "" || parsed.password !== "") throw new AuthRequestError("auth.loginBlock.url carries a username or password");
  if (parsed.origin !== origin) throw new AuthRequestError(`auth.loginBlock.url leaves ${origin}`);
  return value;
}

/**
 * `loginBlock.check`: `{ role, name }`, or `{ url }` as a path on the app's origin (an absolute URL on that origin is reduced to its
 * path, so the CLI may send either). A URL on any other origin is refused: the check is about the APP's own page.
 * @param {unknown} raw @param {string} origin @returns {SignedInCheck}
 */
function signedInCheckOf(raw: unknown, origin: string): SignedInCheck {
  if (!isObject(raw)) throw new AuthRequestError("auth.loginBlock.check must be a mapping with role and name, or url");
  refuseUnknownKeys(raw, ["role", "name", "url"], "auth.loginBlock.check");
  if (raw.url === undefined) {
    if (!isName(raw.role) || !isName(raw.name)) throw new AuthRequestError("auth.loginBlock.check names neither an element (role and name) nor a url");
    return { role: raw.role, name: raw.name };
  }
  if (raw.role !== undefined || raw.name !== undefined) throw new AuthRequestError("auth.loginBlock.check takes role and name, or url, not both");
  let resolved;
  try { resolved = typeof raw.url === "string" && !raw.url.startsWith("//") ? new URL(raw.url, origin) : null; } catch { resolved = null; }
  if (resolved === null || resolved.origin !== origin) throw new AuthRequestError(`auth.loginBlock.check.url must be a path on ${origin}`);
  return { url: resolved.pathname };
}

/**
 * `auth.loginBlock`, validated AGAIN here. The variable names are the only credential-shaped things on the wire; a key this worker does
 * not define (`fields` included) is refused by name, so a newer CLI cannot be half-obeyed by an older worker.
 * @param {unknown} raw @param {string} origin @returns {LoginBlockPlan}
 */
function validateLoginBlock(raw: unknown, origin: string): LoginBlockPlan {
  if (!isObject(raw)) throw new AuthRequestError("auth.loginBlock must be a mapping");
  refuseUnknownKeys(raw, LOGIN_BLOCK_KEYS, "auth.loginBlock");
  if (raw.organization !== undefined && !isName(raw.organization)) throw new AuthRequestError("auth.loginBlock.organization must be a name");
  return {
    url: loginBlockUrl(raw.url, origin),
    usernameEnv: envNameOf(raw.usernameEnv, "auth.loginBlock.usernameEnv"),
    passwordEnv: envNameOf(raw.passwordEnv, "auth.loginBlock.passwordEnv"),
    totpEnv: envNameOf(raw.totpEnv, "auth.loginBlock.totpEnv"),
    check: signedInCheckOf(raw.check, origin),
    ...(raw.organization === undefined ? {} : { organization: raw.organization as string }),
  };
}

/**
 * How the request signs in: a `loginBlock` (the screen loop) OR `login` steps, never both, and a block never with a saved `state` (a
 * state stands in for a login and has no screens to loop over).
 * @param {Record<string, unknown>} raw @param {string} origin @returns {{ login: Step[], loginBlock?: LoginBlockPlan }}
 */
function validateSignIn(raw: Record<string, unknown>, origin: string): { login: Step[]; loginBlock?: LoginBlockPlan } {
  if (raw.loginBlock === undefined) return { login: validateLoginSteps(raw.login, origin) };
  if (raw.login !== undefined) throw new AuthRequestError("auth carries both login and loginBlock; a request signs in one way");
  if (raw.state !== undefined) throw new AuthRequestError("auth.loginBlock cannot be combined with auth.state: a saved state has no login screens");
  return { login: [], loginBlock: validateLoginBlock(raw.loginBlock, origin) };
}

/**
 * Validate a request's `auth` again, at THIS boundary, because it arrives over HTTP from anywhere.
 *
 * The login is `loginBlock` or `login` steps (`validateSignIn`). `upTo` counts into `flow`.
 *
 * @param {unknown} raw @param {string} url the capture's URL, whose origin every `goto` is pinned to
 * @returns {AuthPlan}
 */
export function validateAuthRequest(raw: unknown, url: string): AuthPlan {
  if (!isObject(raw)) throw new AuthRequestError("auth must be a mapping with a login");
  refuseUnknownKeys(raw, ["login", "loginBlock", "flow", "upTo", "state", "idpOrigins"], "auth");
  let origin;
  try { origin = new URL(url).origin; } catch { throw new AuthRequestError("auth needs a capture url to pin its origin to"); }
  const signedInBy = validateSignIn(raw, origin);
  const flow = raw.flow === undefined ? [] : validateSteps(raw.flow, origin, "flow");
  const upTo = raw.upTo === undefined ? flow.length : raw.upTo;
  if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 0 || upTo > flow.length) {
    throw new AuthRequestError("auth.upTo must be a step index within auth.flow");
  }
  const plan: AuthPlan = { ...signedInBy, flow, upTo, ...(raw.state === undefined ? {} : { state: stateRef(raw.state) }) };
  return raw.idpOrigins === undefined ? plan : { ...plan, idpOrigins: validateIdpOrigins(raw.idpOrigins, origin) };
}

/**
 * Why one `idpOrigins` entry is not an origin the worker will allow, or `null` when it is one. The CLI's own copy is `idpOriginProblem`
 * in `flows.ts`; the worker holds it again because the list arrives over HTTP from anywhere. The entry is never echoed, since the
 * request may have put a credential in it.
 *
 * @param {unknown} entry @param {string} appOrigin @returns {string | null}
 */
function idpOriginProblem(entry: unknown, appOrigin: string): string | null {
  if (typeof entry !== "string" || entry.trim() === "") return "is not a text";
  if (entry.includes("*")) return "holds a wildcard; list each origin exactly";
  let parsed;
  try { parsed = new URL(entry); } catch { return "is not an http or https origin"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "is not an http or https origin";
  if (parsed.username !== "" || parsed.password !== "") return "carries a username or password";
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return "carries a path, query or fragment; an origin is a scheme, a host and a port";
  return parsed.origin === appOrigin ? "is the app's own origin, which needs no allowance" : null;
}

/**
 * `auth.idpOrigins`: exact origins a LOGIN may pass through, normalised to `URL.origin` and de-duplicated.
 * @param {unknown} raw @param {string} appOrigin @returns {string[]}
 */
function validateIdpOrigins(raw: unknown, appOrigin: string): string[] {
  if (!Array.isArray(raw)) throw new AuthRequestError("auth.idpOrigins must be a list of origins");
  const origins = raw.map((entry, index) => {
    const problem = idpOriginProblem(entry, appOrigin);
    if (problem !== null) throw new AuthRequestError(`auth.idpOrigins entry ${index + 1} ${problem}`);
    return new URL(entry).origin;
  });
  return [...new Set(origins)];
}

/**
 * `auth.state`: an absolute path and nothing else (amendment 7, choice 5). The value is never echoed in a refusal, since a
 * request that put something other than a path here may have put a value here.
 * @param {unknown} raw @returns {{ path: string }}
 */
function stateRef(raw: unknown): { path: string; } {
  if (!isObject(raw)) throw new AuthRequestError("auth.state must be a mapping with a path");
  refuseUnknownKeys(raw, ["path"], "auth.state");
  if (typeof raw.path !== "string" || !isAbsolute(raw.path)) throw new AuthRequestError("auth.state.path must be an absolute path");
  return { path: raw.path };
}

/** Every environment-variable NAME a plan reads, so a missing one is found before any browser opens. */
/** @param {AuthPlan} plan @returns {string[]} */
export function requiredEnvNames(plan: AuthPlan): string[] {
  // A state run never executes the login's steps (only its final `expect:`), so it reads none of the login's variables.
  const steps = plan.state === undefined ? [...plan.login, ...plan.flow.slice(0, plan.upTo)] : plan.flow.slice(0, plan.upTo);
  // The authenticator secret is NOT here: a login with no MFA reads none, so its absence is the loop's `mfa-required-no-seed`, not a refusal.
  const block = plan.loginBlock === undefined ? [] : [plan.loginBlock.usernameEnv, plan.loginBlock.passwordEnv];
  const names = steps.flatMap((step) => ("fill" in step && step.fill.fromEnv !== undefined ? [step.fill.fromEnv] : []));
  return [...new Set([...block, ...names])];
}

/**
 * The authenticator secret a block names, or undefined when its variable is unset or empty (an account with no MFA needs none). **A value
 * that is set and cannot be used is refused here, BEFORE a browser opens and a password is typed**, naming the variable; the
 * explanation is `TotpSeedError`'s, which never carries the secret, and anything else is reduced to a fixed sentence.
 * @param {LoginBlockPlan} block @param {Record<string, string | undefined>} env @returns {TotpSecret | undefined}
 */
export function totpSecretFor(block: LoginBlockPlan, env: Record<string, string | undefined>): TotpSecret | undefined {
  const value = env[block.totpEnv];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return parseTotpSecret(value);
  } catch (error) {
    const why = error instanceof TotpSeedError ? error.message : "it is not a base32 seed or an otpauth://totp URI";
    throw captureFault(FAULT.AUTH_CREDENTIAL_MISSING, `the authenticator secret in ${block.totpEnv} cannot be used: ${why}`);
  }
}

/**
 * The value of a variable, or `auth-credential-missing` naming the variable and never a value.
 * @param {string} name @param {Record<string, string | undefined>} env @returns {string}
 */
export function readCredential(name: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  if (typeof value === "string" && value !== "") return value;
  throw captureFault(FAULT.AUTH_CREDENTIAL_MISSING,
    `${name} is not set, or is empty, in the environment of the machine that drives the browser`);
}

/**
 * Fail BEFORE anything is launched if a variable the plan reads is absent. Not a login attempt that fails at the
 * form with an empty field, which an account with lockout would count.
 * @param {AuthPlan} plan @param {Record<string, string | undefined>} env
 */
export function assertCredentialsPresent(plan: AuthPlan, env: Record<string, string | undefined>) {
  for (const name of requiredEnvNames(plan)) readCredential(name, env);
  if (plan.loginBlock !== undefined) totpSecretFor(plan.loginBlock, env);
}

// ---------------------------------------------------------------------------------------------------------------
// A saved storage state (ADR 0038, amendment 7). DUPLICATED from `packages/cli/src/auth/state-file.ts` and `scrub.ts`
// (`stateEntriesFor`), because this file cannot import them; `interpreter.test.ts` runs one table through both.
// ---------------------------------------------------------------------------------------------------------------

const SAME_SITE = ["Strict", "Lax", "None"];

/** @param {unknown} cookie @param {string} at @returns {string | undefined} why one cookie is not a cookie: names a field, never a value */
function cookieProblem(cookie: unknown, at: string): string | undefined {
  if (!isObject(cookie)) return `${at} is not an object`;
  for (const field of ["name", "value", "domain"]) {
    if (typeof cookie[field] !== "string") return `${at} has no string "${field}"`;
  }
  if (cookie.domain === "") return `${at} has an empty "domain"`;
  if (cookie.path !== undefined && typeof cookie.path !== "string") return `${at} has a "path" that is not a string`;
  if (cookie.expires !== undefined && typeof cookie.expires !== "number") return `${at} has an "expires" that is not a number`;
  for (const field of ["httpOnly", "secure"]) {
    if (cookie[field] !== undefined && typeof cookie[field] !== "boolean") return `${at} has a "${field}" that is not true or false`;
  }
  if (cookie.sameSite !== undefined && !SAME_SITE.includes((cookie.sameSite as string))) return `${at} has a "sameSite" that is not Strict, Lax or None`;
  return undefined;
}

/** @param {unknown} entry @param {string} at @returns {string | undefined} */
function originProblem(entry: unknown, at: string): string | undefined {
  if (!isObject(entry)) return `${at} is not an object`;
  if (typeof entry.origin !== "string") return `${at} has no string "origin"`;
  if (!Array.isArray(entry.localStorage)) return `${at} has no "localStorage" list`;
  for (const [index, item] of entry.localStorage.entries()) {
    if (!isObject(item) || typeof item.name !== "string" || typeof item.value !== "string") {
      return `${at}.localStorage[${index + 1}] is not an object with a string "name" and a string "value"`;
    }
  }
  return undefined;
}

/**
 * Why a parsed value is not a storage state, or undefined when it is. Places are 1-based and match the `state cookie 3` names
 * the CLI's scrub set uses. Never a name or a value.
 * @param {unknown} raw @returns {string | undefined}
 */
export function stateShapeProblem(raw: unknown): string | undefined {
  if (!isObject(raw)) return "is not a storage state: the top level must be an object";
  if (!Array.isArray(raw.cookies)) return "is not a storage state: it has no \"cookies\" list";
  if (!Array.isArray(raw.origins)) return "is not a storage state: it has no \"origins\" list";
  for (const [index, cookie] of raw.cookies.entries()) {
    const problem = cookieProblem(cookie, `cookies[${index + 1}]`);
    if (problem) return `is not a storage state: ${problem}`;
  }
  for (const [index, entry] of raw.origins.entries()) {
    const problem = originProblem(entry, `origins[${index + 1}]`);
    if (problem) return `is not a storage state: ${problem}`;
  }
  return undefined;
}

/**
 * A cookie is sent to `host` when it is host-only and equal, or a domain cookie (leading dot) and `host` is that domain or a
 * subdomain of it (RFC 6265 section 5.1.3).
 * @param {string} domain @param {string} host
 */
function cookieCoversHost(domain: string, host: string) {
  const wanted = domain.toLowerCase();
  const here = host.toLowerCase();
  if (!wanted.startsWith(".")) return wanted === here;
  return here === wanted.slice(1) || here.endsWith(wanted);
}

/**
 * The entries of a state that belong to `origin`: the cookies whose domain covers its host, and its own `localStorage`. Cookies
 * for other hosts and `localStorage` for other origins are neither loaded nor read. The CLI's own copy is `stateEntriesFor` in
 * `scrub.ts`, and the two are pinned equal by a table.
 * @param {{ cookies: readonly StateCookie[], origins: readonly { origin: string, localStorage: readonly { name: string, value: string }[] }[] }} state @param {string} origin
 * @returns {StateEntries}
 */
export function stateEntriesFor(state: { cookies: readonly StateCookie[]; origins: readonly { origin: string; localStorage: readonly { name: string; value: string; }[]; }[]; }, origin: string): StateEntries {
  const host = new URL(origin).hostname;
  return {
    cookies: state.cookies.flatMap((cookie, index) => (cookieCoversHost(cookie.domain, host) ? [{ ...cookie, place: index + 1 }] : [])),
    localStorage: state.origins.filter((entry) => entry.origin === origin)
      .flatMap((entry) => entry.localStorage.map((item, index) => ({ place: index + 1, name: item.name, value: item.value }))),
  };
}

/**
 * Read and validate the state file, and select what belongs to `url`'s origin. **A file that cannot be read, is not JSON or is
 * the wrong shape is refused naming the PATH and the REASON and never a fragment of the file**: `JSON.parse`'s own message
 * quotes the text it choked on, so it is not repeated.
 * @param {string} path @param {string} url @param {(path: string) => string} readText @returns {StateEntries}
 */
export function loadStateEntries(path: string, url: string, readText: (path: string) => string): StateEntries {
  let text;
  try {
    text = readText(path);
  } catch (error) {
    throw new AuthRequestError(`the state file ${path} could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AuthRequestError(`the state file ${path} is not valid JSON`);
  }
  const problem = stateShapeProblem(raw);
  if (problem) throw new AuthRequestError(`the state file ${path} ${problem}`);
  return stateEntriesFor(raw, new URL(url).origin);
}

/**
 * The plan with its saved state's entries loaded, or the plan unchanged when it names none.
 * @param {AuthPlan} plan @param {string} url @param {(path: string) => string} [readText]
 * @returns {AuthPlan}
 */
export function withLoadedState(plan: AuthPlan, url: string, readText: (path: string) => string = (path) => readFileSync(path, "utf8")): AuthPlan {
  if (plan.state === undefined) return plan;
  return { ...plan, state: { path: plan.state.path, entries: loadStateEntries(plan.state.path, url, readText) } };
}

/**
 * The capture options an `auth` request decides — everything about authentication that `captureOptions` (in
 * `server.ts`, which needs a screen reader to import and so has no test) would otherwise decide inline.
 *
 * With `auth`: the plan, validated AGAIN here (it arrives over HTTP from anywhere), its saved state (if it names one) read
 * and validated by THIS process, every variable it reads checked present in THIS process's environment before anything is launched, and `reuseBrowser` FORCED OFF whatever
 * the request or the fleet default says — a reused browser keeps its renderer, so a session left in it would be the
 * next capture's session. Without `auth`: nothing, which is every request an older host sends.
 *
 * @param {{ parsed: { auth?: unknown, url: string }, env: Record<string, string | undefined> }} request
 * @returns {{ auth?: AuthPlan, reuseBrowser?: false }}
 */
export function authOptionsFor({ parsed, env }: { parsed: { auth?: unknown; url: string; }; env: Record<string, string | undefined>; }): { auth?: AuthPlan; reuseBrowser?: false; } {
  if (parsed.auth === undefined) return {};
  const auth = withLoadedState(validateAuthRequest(parsed.auth, parsed.url), parsed.url);
  assertCredentialsPresent(auth, env);
  return { auth, reuseBrowser: false };
}

/**
 * The positive acknowledgement (ADR 0038, clause 1): `{ authApplied: true }` only for an authenticated capture whose
 * sign-in RAN TO ITS END, read from the marks the interpreter leaves at the very last moment. Anything less is an
 * empty object, and the CLI treats a missing `authApplied` as `auth-not-applied` and no report.
 *
 * @param {{ auth: AuthPlan | undefined, marks: ReadonlyArray<{ event: string }> }} capture
 * @returns {{ authApplied?: true }}
 */
export function authAcknowledgement({ auth, marks }: { auth: AuthPlan | undefined; marks: ReadonlyArray<{ event: string; }>; }): { authApplied?: true; } {
  return auth !== undefined && marks.some((mark) => mark.event === "authApplied") ? { authApplied: true } : {};
}

/**
 * How the result store holds a capture's response: an authenticated one for ONE delivery (`capture-results.ts`),
 * everything else exactly as it always was.
 *
 * @param {{ auth?: AuthPlan }} opts @returns {{ deliverOnce: boolean }}
 */
export function retentionFor(opts: { auth?: AuthPlan; }): { deliverOnce: boolean; } {
  return { deliverOnce: opts.auth !== undefined };
}

/** `127.0.0.0/8`, `::1` and `::ffff:127.x`, as a socket reports its peer. An SSH tunnel presents as loopback (ADR 0038). */
/** @param {string | undefined} address */
export function isLoopbackPeer(address: string | undefined) {
  if (!address) return false;
  const bare = address.replace(/^::ffff:/i, "");
  return bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * The worker refuses too, and an older worker cannot be trusted to (clause 1): an auth request whose socket peer is
 * not loopback is answered `403 auth-refused-remote-worker`. Returns the answer, or null when the request may go on.
 *
 * @param {{ auth: unknown, peer: string | undefined }} request
 * @returns {{ status: number, body: { error: string, fault: string } } | null}
 */
export function authGate({ auth, peer }: { auth: unknown; peer: string | undefined; }): { status: number; body: { error: string; fault: string; }; } | null {
  if (auth === undefined || isLoopbackPeer(peer)) return null;
  return {
    status: 403,
    body: {
      error: "This worker takes plain HTTP with no authentication and no TLS, so it does not accept a login from "
        + "a peer that is not on this machine. Nothing was captured.",
      fault: FAULT.AUTH_REFUSED_REMOTE_WORKER,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Matching controls by ACCESSIBLE NAME, over the accessibility tree — never by selector.
// ---------------------------------------------------------------------------------------------------------------

type AxNode = { id: string, role: string, name: string, parentId?: string, backendId?: number, ignored: boolean };

const FILL_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];
const CHECK_ROLES = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"];
const CHOOSE_ROLES = ["combobox", "listbox"];
const PRESS_ROLES = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "switch",
  "checkbox", "radio", "option"];

/** @param {unknown} text */
export const normalise = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * @param {AxNode[]} nodes @param {{ roles: string[], name: string, within?: string }} query @returns {AxNode[]}
 */
export function controlsNamed(nodes: AxNode[], { roles, name, within }: { roles: string[]; name: string; within?: string; }): AxNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const wanted = normalise(name);
  const inside = (node: AxNode) => {
    if (within === undefined) return true;
    for (let up = node.parentId ? byId.get(node.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) {
      if (normalise(up.name) === normalise(within)) return true;
    }
    return false;
  };
  return nodes.filter((node) => !node.ignored && roles.includes(node.role) && normalise(node.name) === wanted && inside(node));
}

/** @param {AxNode[]} nodes @param {{ kind: "heading" | "control" | "text", name: string }} expected */
export function expectationMet(nodes: AxNode[], { kind, name }: { kind: "heading" | "control" | "text"; name: string; }) {
  const wanted = normalise(name);
  const live = nodes.filter((node) => !node.ignored);
  if (kind === "heading") return live.some((node) => node.role === "heading" && normalise(node.name) === wanted);
  if (kind === "control") {
    const roles = [...FILL_ROLES, ...CHECK_ROLES, ...PRESS_ROLES];
    return live.some((node) => roles.includes(node.role) && normalise(node.name) === wanted);
  }
  return live.some((node) => normalise(node.name).includes(wanted));
}

// ---------------------------------------------------------------------------------------------------------------
// The interpreter.
// ---------------------------------------------------------------------------------------------------------------

type AuthDriver = {
  navigate(url: string): Promise<{ ok: boolean, error?: string }>,
  origin(): Promise<string>,
  url?(): Promise<string>,
  axNodes(): Promise<AxNode[]>,
  inputType(handle: number): Promise<string>,
  fill(handle: number, text: string): Promise<void>,
  choose(handle: number, option: string): Promise<boolean>,
  frameSources(): Promise<string[]>,
  isChecked(handle: number): Promise<boolean>,
  click(handle: number): Promise<void>,
  /** The control's `autocomplete` attribute, or "" (the screen loop reads it, never a class). Optional: a driver without it recognises by name alone. */
  autocompleteOf?(handle: number): Promise<string>,
  /** Press Enter in the control, for a form that has no button to press. Optional: without it such a form ends the login rather than guessing. */
  pressEnter?(handle: number): Promise<void>,
  setCookies(cookies: StateCookie[]): Promise<void>,
  setLocalStorage(entries: { name: string, value: string }[]): Promise<void>,
  purge(origin: string): Promise<void>,
  close(): Promise<void>,
};

/**
 * What the interpreter needs from a browser. Two implementations exist or will: the CDP driver below, and
 * Playwright in the CLI (PR 5). Handles are opaque to the interpreter.
 *
 * */

/**
 * What a login failure was, by name. The first three are a step that failed; the loop's outcomes are `screen-loop.ts`'s, and the last is
 * the loop's one refusal that is a fact about the CHECK (the signed-out start page already satisfied it).
 */
type LoginFailureReason = "expect-not-met" | "unbindable-field" | "left-origin" | LoginOutcome | "signed-in-check-matches-signed-out";

/**
 * `auth-login-failed`, with the reason, the step and the verb — and no value. `where` and `detail` stay on the error: a
 * saved-state run states the same fact and gives different advice (`stateExpired`).
 * @param {LoginFailureReason} reason @param {string} where @param {string} detail @param {string} [advice]
 */
function loginFailed(reason: LoginFailureReason, where: string, detail: string, advice?: string) {
  return Object.assign(captureFault(FAULT.AUTH_LOGIN_FAILED, `the login did not complete (${reason}) at ${where}: ${detail}${advice ? `. ${advice}` : ""}`),
    { reason, where, detail });
}

/**
 * The ONE page-side read a challenge check needs: a fixed string for `Runtime.evaluate`, never built from anything a flow
 * says. The `src` of the iframes the main document RENDERS: `display: none` and `visibility: hidden` are dropped, because a
 * frame nobody can see is not a challenge in front of the user and reCAPTCHA parks a hidden one on every page carrying a
 * widget. The accessibility tree cannot answer it (an `Iframe` node carries the `title`, which no vendor documents, and no
 * `src`). The CLI's own copy is `FRAME_SOURCES_EXPRESSION` in `interpreter.ts`.
 */
export const FRAME_SOURCES_EXPRESSION = "Array.from(document.querySelectorAll('iframe'))"
  + ".filter((f) => f.getClientRects().length > 0 && getComputedStyle(f).visibility !== 'hidden').map((f) => f.src)";

/**
 * The CAPTCHA vendor whose widget one of these iframe sources is, or undefined. **The hosts are the vendors' own, from the
 * Content-Security-Policy pages they publish for the `frame-src` a widget needs, read 2026-09-26 (none of the three pages
 * shows a date):** reCAPTCHA (https://developers.google.com/recaptcha/docs/faq) `https://www.google.com/recaptcha/` and
 * `https://recaptcha.google.com/recaptcha/`; hCaptcha (https://docs.hcaptcha.com/) `https://hcaptcha.com` and
 * `https://*.hcaptcha.com`; Cloudflare Turnstile (https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
 * `https://challenges.cloudflare.com`. Not matched: `recaptcha.net`, Arkose, GeeTest, Friendly Captcha, and a challenge a
 * site serves from its own origin. What is documented is where the frame comes from, not what it is titled, so the title
 * is not read. The CLI's own copy is `challengeVendor` in `interpreter.ts`.
 *
 * @param {readonly string[]} sources @returns {string | undefined}
 */
export function challengeVendor(sources: readonly string[]): string | undefined {
  for (const source of sources) {
    let url;
    try { url = new URL(source); } catch { continue; } // an iframe with no src is "" and has nothing to match
    if (url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase();
    if ((host === "www.google.com" || host === "recaptcha.google.com") && url.pathname.startsWith("/recaptcha/")) return "reCAPTCHA";
    if (host === "hcaptcha.com" || host.endsWith(".hcaptcha.com")) return "hCaptcha";
    if (host === "challenges.cloudflare.com") return "Cloudflare Turnstile";
  }
  return undefined;
}

/**
 * A step that FAILED, explained (#2564): a CAPTCHA widget rendered on the page that failed it is `auth-challenge-detected`,
 * and anything else is the login failure it was going to be. **This runs only where a step has already failed, never on a
 * success**, so a dashboard carrying a reCAPTCHA v3 badge still passes its `expect:`; the price is that a step which failed
 * for an unrelated reason on a page that also carries a widget is reported as the challenge, said in the sentence. It NAMES
 * the challenge and does nothing to it. A read that fails (the page navigating under it) leaves the original failure
 * standing, with the reason it could not look in its detail. The CLI's own copy is `explainFailure` in `interpreter.ts`.
 *
 * @param {AuthDriver} driver
 * @param {LoginFailureReason} reason @param {string} where @param {string} detail
 */
async function explainFailure(driver: AuthDriver, reason: LoginFailureReason, where: string, detail: string) {
  let vendor;
  try {
    vendor = challengeVendor(await driver.frameSources());
  } catch (error) {
    return loginFailed(reason, where, `${detail} (the page's frames could not be read to check for a CAPTCHA: ${error instanceof Error ? error.message : String(error)})`);
  }
  if (vendor === undefined) return loginFailed(reason, where, detail);
  return captureFault(FAULT.AUTH_CHALLENGE_DETECTED, `the login stopped at ${where}, and a widget from ${vendor} is on the page. This run names a CAPTCHA `
    + "and never answers one: it is there to stop automated sign-ins, and nothing here will click it, wait it out or work around it. "
    + `The step failed as ${reason}: ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `attempt` returns something other than undefined, or the bound passes. A wait for a CONDITION, with a
 * deadline: never a fixed sleep (the vocabulary has none, and this is what its `expect` is).
 *
 * @template T
 * @param {() => Promise<T | undefined>} attempt @param {number} boundMs
 * @returns {Promise<T | undefined>}
 */
async function until<T>(attempt: () => Promise<T | undefined>, boundMs: number): Promise<T | undefined> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    const found = await attempt();
    if (found !== undefined || Date.now() >= deadline) return found;
    await sleep(POLL_MS);
  }
}

/**
 * Bind ONE control by accessible name: exactly one match, or `nth` picks among several, or it is unbindable —
 * which on a login is not a finding to report beside a page but the end of the run, because nothing after it
 * can be examined. That is a real 4.1.2 failure of the product under test, and the message says so.
 *
 * @param {AuthDriver} driver
 * @param {{ roles: string[], name: string, within?: string, nth?: number }} query @param {string} where
 * @param {number} boundMs how long the control may take to appear
 * @returns {Promise<number>} the control's handle
 */
async function bindControl(driver: AuthDriver, query: { roles: string[]; name: string; within?: string; nth?: number; }, where: string, boundMs: number): Promise<number> {
  let seen: AxNode[] = [];
  const found = await until(async () => {
    seen = controlsNamed(await driver.axNodes(), query);
    const pick = query.nth === undefined ? (seen.length === 1 ? seen[0] : undefined) : seen[query.nth - 1];
    return pick?.backendId === undefined ? undefined : pick.backendId;
  }, boundMs);
  if (found !== undefined) return found;
  if (seen.length === 0) {
    throw await explainFailure(driver, "unbindable-field", where, `no control is named "${query.name}". A control the script cannot `
      + "address by accessible name is one a screen-reader user cannot address either; that is a 4.1.2 finding about the page.");
  }
  throw loginFailed("unbindable-field", where, `${seen.length} controls are named "${query.name}"; say which with within or nth. `
    + "A control the script cannot address by accessible name is one a screen-reader user cannot address either; that is a 4.1.2 finding about the page.");
}

/** How long the page may take to settle enough to be asked where it is. A bound on a wait for a condition. */
const ORIGIN_SETTLE_MS = 5_000;

/**
 * Where the page is NOW. A click that starts a navigation destroys the document under the question, and the browser
 * answers that with an error rather than a value; that is "not yet", so it is asked again until it answers or the bound
 * passes. The last error is then the reason, not a guess.
 *
 * @param {AuthDriver} driver @returns {Promise<string>}
 */
async function currentOrigin(driver: AuthDriver): Promise<string> {
  let last: unknown;
  const found = await until(async () => {
    try { return await driver.origin(); } catch (error) { last = error; return undefined; }
  }, ORIGIN_SETTLE_MS);
  if (found === undefined) throw new Error("the page would not say where it is", { cause: last });
  return found;
}

/**
 * Is the page the login wall? ALL of the controls the login FILLS are on it, found by accessible name. The flow's final
 * `expect:` is the wrong signal: it holds on the dashboard and on no other page, so re-checking it on `/settings` would
 * end healthy runs. A page with ONE control named like ONE login field (a "Password" box on a change-password page) is
 * not the wall, and a login that fills nothing has no form to recognise, so it never is (`[].every` would say yes).
 * The CLI's own copy is `landedOnLoginForm` in `interpreter.ts`.
 *
 * @param {AxNode[]} nodes @param {AuthPlan["login"]} login
 */
export function landedOnLoginForm(nodes: AxNode[], login: AuthPlan["login"]) {
  const fields = login.flatMap((step) => ("fill" in step ? [step.fill] : []));
  return fields.length > 0 && fields.every(({ field, within }) => controlsNamed(nodes, { roles: FILL_ROLES, name: field, within }).length > 0);
}

/**
 * A successful login followed by the login form on the page the run asked for: the session did not hold, or the page
 * bounced or rendered the wall in place. Nothing else names it — a same-origin redirect ends as `wrong-page`, and a wall
 * rendered in place is captured as the page. Reads the main frame's accessibility tree only, so a form in an iframe is
 * not seen (ADR 0038's fault list).
 *
 * @param {AuthDriver} driver @param {AuthPlan["login"]} login
 */
async function assertNotShownLoginWall(driver: AuthDriver, login: AuthPlan["login"]) {
  if (!landedOnLoginForm(await driver.axNodes(), login)) return;
  const names = login.flatMap((step) => ("fill" in step ? [`"${step.fill.field}"`] : []));
  throw captureFault(FAULT.AUTH_SESSION_LOST, "the login succeeded, and then the requested page showed the login form: every field the "
    + `login fills (${[...new Set(names)].join(", ")}) is on the page the run landed on. The session did not hold, so this page was `
    + "not examined as the product.");
}

/**
 * The page must be on the pinned origin, or on one of `allowed`: the identity-provider origins the flow declared, passed ONLY while
 * the login is between its steps (`allowedOrigins`). An origin not named there ends `left-origin` with the sentence it always had.
 * The CLI's own copy is `assertStillOnOrigin` in `interpreter.ts`.
 *
 * @param {AuthDriver} driver @param {string} origin @param {string} where @param {readonly string[]} [allowed]
 */
async function assertStillOnOrigin(driver: AuthDriver, origin: string, where: string, allowed: readonly string[] = []) {
  const now = await currentOrigin(driver);
  if (now !== origin && !allowed.includes(now)) {
    throw loginFailed("left-origin", where, `the page is on ${now}, not ${origin}`,
      "A redirect to an identity provider this flow does not declare ends the run: declare its origin under idp-origins: in the flows file if it signs in with a form. SSO beyond that is not supported: use a dedicated test account without MFA or SSO.");
  }
}

type RunContext = { steps: Step[], origin: string, driver: AuthDriver, env: Record<string, string | undefined>,
  mark: (event: string, detail: Record<string, unknown>) => void, phase: "login" | "flow", bindTimeoutMs: number,
  idpOrigins?: readonly string[] };

/**
 * The origins besides the app's that the page may be on AFTER this step: only a login's steps before its last (that last is the
 * `expect` the validation guarantees, and a login that ends parked on the identity provider has signed no one in to the app).
 * The flow that follows gets none, so the allowance ends with the login.
 *
 * @param {RunContext} run @param {number} index 1-based, as `runNumbered` counts
 * @returns {readonly string[]}
 */
function allowedOrigins(run: RunContext, index: number): readonly string[] {
  return run.phase === "login" && index < run.steps.length ? run.idpOrigins ?? [] : [];
}

/** @param {Step} step @returns {string} the step's verb, and never a value */
const verbOf = (step: Step): string => (Object.keys(step)[0] as string);

type BindingQuery = { roles: string[]; name: string; within?: string; nth?: number };

/** The control a step binds, by the roles `runStep` binds it by. `goto`, `expect` and `capture` bind none, so `optional:` has nothing to wait for. */
function bindingQuery(step: Step): BindingQuery | undefined {
  if ("fill" in step) return { roles: FILL_ROLES, name: step.fill.field, within: step.fill.within, nth: step.fill.nth };
  if ("choose" in step) return { roles: CHOOSE_ROLES, name: step.choose.field, within: step.choose.within, nth: step.choose.nth };
  if ("check" in step) return { roles: CHECK_ROLES, name: step.check.field, within: step.check.within, nth: step.check.nth };
  if ("press" in step || "dismiss-if-shown" in step) {
    const target = "press" in step ? step.press : step["dismiss-if-shown"];
    return { roles: PRESS_ROLES, name: target.control, within: target.within, nth: target.nth };
  }
  return undefined;
}

/** Is the control on the page now? A name two controls share counts as present: binding it then says "ambiguous", not "absent". */
function controlPresent(nodes: AxNode[], query: BindingQuery): boolean {
  const found = controlsNamed(nodes, query).length;
  return query.nth === undefined ? found > 0 : found >= query.nth;
}

/**
 * Why a step does not run, or undefined when it does. `when:` and `dismiss-if-shown:` read the page ONCE and never wait, so a skipped
 * step costs one read. `optional:` waits as long as a bind would, because a control about to render is not absent yet, and skips only
 * when no control of that name ever appeared. An `expect:` has no `optional:` effect: "its target never appeared" is the timeout that
 * must fail.
 *
 * @param {Step} step @param {RunContext} run @returns {Promise<"when" | "not-shown" | "optional" | undefined>}
 */
async function skipReason(step: Step, run: RunContext): Promise<"when" | "not-shown" | "optional" | undefined> {
  const query = bindingQuery(step);
  if (step.when !== undefined && !expectationMet(await run.driver.axNodes(), step.when)) return "when";
  if ("dismiss-if-shown" in step) return controlPresent(await run.driver.axNodes(), query as BindingQuery) ? undefined : "not-shown";
  if (step.optional !== true || query === undefined) return undefined;
  const appeared = await until(async () => (controlPresent(await run.driver.axNodes(), query) ? true : undefined), run.bindTimeoutMs);
  return appeared ? undefined : "optional";
}

/**
 * @param {Step} step @param {RunContext} run @param {{ where: string, index: number }} position
 */
async function runStep(step: Step, run: RunContext, { where, index }: { where: string; index: number; }) {
  const { driver, origin, env, bindTimeoutMs } = run;
  if ("goto" in step) {
    const result = await driver.navigate(new URL(step.goto, origin).href);
    if (!result.ok) throw loginFailed("expect-not-met", where, `${step.goto} could not be loaded (${result.error ?? "no reason given"})`);
  } else if ("fill" in step) {
    // Only a flow that declares an identity provider can have a fill meet a page that is not the app's, and then it is asked BEFORE
    // typing: the last check was after the previous step, and a page can move on its own since. Nothing is typed into an undeclared origin.
    if ((run.idpOrigins ?? []).length > 0) await assertStillOnOrigin(driver, origin, where, allowedOrigins(run, index));
    const { field, within, nth, value, fromEnv } = step.fill;
    const handle = await bindControl(driver, { roles: FILL_ROLES, name: field, within, nth }, where, bindTimeoutMs);
    const text = fromEnv === undefined ? String(value) : readCredential(fromEnv, env);
    assertLiteralIsNotSecret({ fill: step.fill }, { inputType: await driver.inputType(handle) });
    await driver.fill(handle, text);
  } else if ("choose" in step) {
    const { field, within, nth, option } = step.choose;
    const handle = await bindControl(driver, { roles: CHOOSE_ROLES, name: field, within, nth }, where, bindTimeoutMs);
    if (!await driver.choose(handle, option)) throw loginFailed("unbindable-field", where, `"${field}" has no option "${option}"`);
  } else if ("check" in step) {
    const { field, within, nth, checked } = step.check;
    const handle = await bindControl(driver, { roles: CHECK_ROLES, name: field, within, nth }, where, bindTimeoutMs);
    if (await driver.isChecked(handle) !== checked) await driver.click(handle);
  } else if ("press" in step || "dismiss-if-shown" in step) {
    await driver.click(await bindControl(driver, bindingQuery(step) as BindingQuery, where, bindTimeoutMs));
  } else if ("expect" in step) {
    await expectStepMet(step.expect, run, { where, index });
  }
}

/**
 * @param {{ kind: "heading" | "control" | "text", name: string, timeoutSeconds: number }} expected @param {RunContext} run
 * @param {{ where: string, index: number }} position
 */
async function expectStepMet(expected: { kind: "heading" | "control" | "text"; name: string; timeoutSeconds: number; }, run: RunContext, { where, index }: { where: string; index: number; }) {
  const met = await until(async () => (expectationMet(await run.driver.axNodes(), expected) ? true : undefined),
    expected.timeoutSeconds * MS_PER_SECOND);
  if (!met) {
    throw await explainFailure(run.driver, "expect-not-met", where, `no ${expected.kind} "${expected.name}" appeared within ${expected.timeoutSeconds} s`);
  }
  // A heading on another site is not this site's dashboard: the condition is met only on the pinned origin. A declared identity
  // provider counts for an `expect` in the middle of a login (its page is where the next step happens), and never for the last.
  await assertStillOnOrigin(run.driver, run.origin, where, allowedOrigins(run, index));
}

/**
 * One step, numbered as a person counts: marked by verb and accessible name only, with the origin re-checked after any step
 * that can move the page (`ceo`'s reviewer asked for exactly this: a `press` can redirect off-origin where the parser can
 * only see declared `goto`s). The CLI's own copy is `runNumbered` in `interpreter.ts`.
 *
 * @param {Step} step @param {number} index @param {RunContext} run
 */
async function runNumbered(step: Step, index: number, run: RunContext) {
  const verb = verbOf(step);
  const where = `${run.phase} step ${index} (${verb})`;
  if (verb === "capture") return; // a capture point is where the caller stops; it acts on nothing
  const body = (step as Untyped)[verb];
  const name = typeof body === "string" ? undefined : body.field ?? body.control ?? body.name;
  const skipped = await skipReason(step, run);
  if (skipped !== undefined) return run.mark("authStepSkipped", { phase: run.phase, index, verb, name, because: skipped });
  run.mark("authStep", { phase: run.phase, index, verb, name });
  await runStep(step, run, { where, index });
  if (verb !== "expect") await assertStillOnOrigin(run.driver, run.origin, where, allowedOrigins(run, index));
}

/** @param {RunContext} run */
export async function runSteps(run: RunContext) {
  for (const [index, step] of run.steps.entries()) await runNumbered(step, index + 1, run);
}

/**
 * The fixed function a saved state's `localStorage` is set by (amendment 7, choice 3), handed the entries as DATA
 * (`Runtime.callFunctionOn`'s `arguments`): nothing in the file is ever spliced into script text. Pinned equal to the CLI's.
 */
export const SET_LOCAL_STORAGE_FUNCTION = `function (entries) {
  for (const entry of entries) localStorage.setItem(entry.name, entry.value);
}`;

/**
 * A state cookie as `Network.setCookies` takes it. `path` defaults to `/`; a session cookie's `expires` of `-1` is left off, as
 * Playwright's own loader does. The CLI's own copy is `cookieParam` in `interpreter.ts`.
 * @param {StateCookie} cookie @returns {Record<string, unknown>}
 */
export function cookieParam(cookie: StateCookie): Record<string, unknown> {
  return {
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path ?? "/",
    ...(typeof cookie.expires === "number" && cookie.expires > 0 ? { expires: cookie.expires } : {}),
    ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
    ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
  };
}

/**
 * The saved state, in the browser: cookies first (the first request carries them), then the requested page, the origin's
 * `localStorage`, and a reload. The CLI's own copy is `loadState` in `interpreter.ts`.
 * @param {StateEntries} state @param {{ url: string, driver: AuthDriver, mark: (event: string, detail: Record<string, unknown>) => void }} where
 */
async function loadState(state: StateEntries, { url, driver, mark }: { url: string; driver: AuthDriver; mark: (event: string, detail: Record<string, unknown>) => void; }) {
  const load = async () => {
    const loaded = await driver.navigate(url);
    if (!loaded.ok) throw loginFailed("expect-not-met", "loading the saved state", `${url} could not be loaded (${loaded.error ?? "no reason given"})`);
  };
  await driver.setCookies(state.cookies);
  await load(); // `localStorage` needs a document on the origin to be set on
  await driver.setLocalStorage(state.localStorage);
  await load(); // and the page must read it, which it did not at its first load
  mark("authStateLoaded", { cookies: state.cookies.length, localStorage: state.localStorage.length });
}

/**
 * A saved state that did not sign the run in: the same fact the form login reports as `expect-not-met` or `left-origin`, with
 * different advice, because there was no login to fail. The CLI's own copy is `stateExpired` in `interpreter.ts`.
 * @param {Error & { where: string, detail: string }} error
 */
function stateExpired(error: Error & { where: string; detail: string; }) {
  return captureFault(FAULT.AUTH_STATE_EXPIRED, `the saved state did not sign the run in (${error.where}): ${error.detail}`);
}

/**
 * The state stands in for the sign-in: it is loaded, and then the login's FINAL step (its `expect:`) runs on the page the run
 * requested. The login's other steps never run. A CAPTCHA widget on the page still ends `auth-challenge-detected`. The CLI's
 * own copy is `signInFromState` in `interpreter.ts`.
 * @param {StateEntries} state @param {RunContext} run @param {string} url
 */
async function signInFromState(state: StateEntries, run: RunContext, url: string) {
  await loadState(state, { url, driver: run.driver, mark: run.mark });
  try {
    await runNumbered(run.steps[run.steps.length - 1], run.steps.length, run);
  } catch (error) {
    const reason = (error as { reason?: string }).reason;
    if (faultCode(error) === FAULT.AUTH_LOGIN_FAILED && (reason === "expect-not-met" || reason === "left-origin")) {
      throw stateExpired((error as Untyped));
    }
    throw error;
  }
}

/**
 * The requested page, loaded once the login and flow have run. **A flow that declares an identity provider and ends ON the requested
 * page does not load it again**: the token such a login yields can live only in the page's memory, and a load discards it. Every
 * other run loads it, as before; so does a driver that cannot say where the page is. The CLI's own copy is `loadRequestedPage` in
 * `interpreter.ts`.
 *
 * @param {{ driver: AuthDriver, url: string, idpOrigins: readonly string[], land?: (url: string) => Promise<{ ok: boolean, error?: string }> }} request
 */
async function loadRequestedPage({ driver, url, idpOrigins, land }: { driver: AuthDriver; url: string; idpOrigins: readonly string[]; land?: (url: string) => Promise<{ ok: boolean; error?: string; }>; }) {
  if (idpOrigins.length > 0 && driver.url !== undefined && new URL(await driver.url()).href === new URL(url).href) return;
  const landed = await (land ?? ((target) => driver.navigate(target)))(url);
  if (!landed.ok) throw loginFailed("expect-not-met", "the requested page", `${url} could not be loaded after the login (${landed.error ?? "no reason given"})`);
}

// ---------------------------------------------------------------------------------------------------------------
// The screen loop's glue (a11ign#4998). `screen-loop.ts` is pure: this reads the page into its observation, carries out its
// actions, and says in the closed fault list what it ended with. A screen is recognised by ACCESSIBLE NAME and `autocomplete`
// token and never by CSS, and a value is typed at the moment it is needed, from a variable NAMED by the request.
// ---------------------------------------------------------------------------------------------------------------

/**
 * How long the loop may run from its first observation. Chosen, not measured: four screens an identity provider shows in a row, each
 * with a navigation, fit in a fraction of it, and a loop that has not signed in by then is not going to. A BOUND on a wait for a
 * condition; the loop polls inside it and never sleeps a fixed time between steps.
 */
export const LOGIN_LOOP_BUDGET_MS = 90_000;

/** The sentence the CLI prints when the check passes before any login (`signed-in-check-matches-signed-out`), word for word. */
const CHECK_MATCHES_SIGNED_OUT = "The signed-in check matched the signed-out page, so the login did not sign in: check the credentials and the steps before it.";

/** What the loop looks at: the inputs it types into and the controls it presses, plus an `alert` that carries a rejection. */
const LOOP_ROLES = new Set([...FILL_ROLES, "button", "link", "radio", "option", "menuitem", "checkbox", "alert"]);

type LoopContext = {
  driver: AuthDriver, origin: string, env: Record<string, string | undefined>,
  mark: (event: string, detail: Record<string, unknown>) => void, idpOrigins: readonly string[], budgetMs: number,
  /** Where each control of the LAST observation is, so an action on it is an action on what the loop classified. */
  handles: WeakMap<ScreenControl, number>,
  lastSeen?: ScreenObservation,
  /** The authenticator window a code was last typed in: a time step is never typed twice (a reused code is a rejected code). */
  usedWindow?: number,
};

/** The text under an `alert`, whose own name is empty in the accessibility tree: its static text, in order. */
function textUnder(nodes: AxNode[], ancestorId: string): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const isInside = (node: AxNode) => {
    for (let up = node.parentId ? byId.get(node.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) {
      if (up.id === ancestorId) return true;
    }
    return false;
  };
  return normalise(nodes.filter((node) => !node.ignored && node.role === "StaticText" && isInside(node)).map((node) => node.name).join(" "));
}

/**
 * The page as the loop sees it: its headings, and its controls by role, accessible name and `autocomplete` token. `className` is never
 * read from the page, so the loop has nothing to classify by but what a person is given.
 * @param {AuthDriver} driver @param {AxNode[]} nodes
 */
async function readScreen(driver: AuthDriver, nodes: AxNode[]) {
  const live = nodes.filter((node) => !node.ignored);
  const handles = new WeakMap<ScreenControl, number>();
  const controls: ScreenControl[] = [];
  for (const node of live.filter((candidate) => LOOP_ROLES.has(candidate.role))) {
    const typed = FILL_ROLES.includes(node.role) && node.backendId !== undefined && driver.autocompleteOf !== undefined;
    const autocomplete = typed ? await driver.autocompleteOf!(node.backendId as number) : "";
    const named = normalise(node.name);
    const name = node.role === "alert" && named === "" ? textUnder(nodes, node.id) : named;
    const control: ScreenControl = { role: node.role, name, ...(autocomplete === "" ? {} : { autocomplete }) };
    controls.push(control);
    if (node.backendId !== undefined) handles.set(control, node.backendId);
  }
  const headings = live.filter((node) => node.role === "heading" && normalise(node.name) !== "").map((node) => normalise(node.name));
  return { controls, headings, handles };
}

/** A URL check is a whole-path-segment prefix, as the CLI's `signed-in-check.ts` reads it: `/account` covers `/account/orders`, not `/accounts`. */
function pathUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** The signed-in check holds: it is shown AND the page is on the app's origin (an element on the identity provider's page is the provider's). */
async function checkHolds(check: SignedInCheck, ctx: { driver: AuthDriver, origin: string }, nodes: AxNode[]): Promise<boolean> {
  if (await currentOrigin(ctx.driver) !== ctx.origin) return false;
  if ("url" in check) {
    if (ctx.driver.url === undefined) throw new Error("this driver cannot say where the page is, which a url check needs");
    return pathUnderPrefix(new URL(await ctx.driver.url()).pathname, check.url);
  }
  return nodes.some((node) => !node.ignored && node.role === check.role && normalise(node.name) === normalise(check.name));
}

/**
 * One observation, read AFTER the origin is confirmed: nothing is classified, let alone typed into, on an origin the flow did not name.
 * A read that fails because the page is navigating is a blank page, recorded as a mark, and the loop polls on it.
 * @param {LoginBlockPlan} block @param {LoopContext} ctx @returns {Promise<ScreenObservation>}
 */
async function observeScreen(block: LoginBlockPlan, ctx: LoopContext): Promise<ScreenObservation> {
  await assertStillOnOrigin(ctx.driver, ctx.origin, "the login screens", ctx.idpOrigins);
  let seen: ScreenObservation;
  try {
    const nodes = await ctx.driver.axNodes();
    const { controls, headings, handles } = await readScreen(ctx.driver, nodes);
    ctx.handles = handles;
    seen = { controls, headings, signedIn: await checkHolds(block.check, ctx, nodes) };
  } catch (error) {
    ctx.mark("authScreenUnread", { reason: error instanceof Error ? error.message : String(error) });
    seen = { controls: [], headings: [], signedIn: false };
  }
  ctx.lastSeen = seen;
  return seen;
}

/** The handle of a control of the last observation, or `unbindable-field` when it is gone: the page moved between the read and the act. */
function handleOf(target: ScreenControl, ctx: LoopContext): number {
  const handle = ctx.handles.get(target);
  if (handle === undefined) {
    throw loginFailed("unbindable-field", "the login screens", `the ${target.role} "${target.name}" is no longer on the page`);
  }
  return handle;
}

/**
 * A code for the authenticator window NOW, made immediately before it is typed (`codeForUse` waits out a window's last seconds), and never
 * for a window one was already typed in: waiting for the next is slower and is what keeps a second screen from submitting a used code.
 */
async function freshCode(block: LoginBlockPlan, ctx: LoopContext): Promise<string> {
  const secret = totpSecretFor(block, ctx.env);
  if (secret === undefined) throw captureFault(FAULT.AUTH_CREDENTIAL_MISSING, `${block.totpEnv} is not set, or is empty, in the environment of the machine that drives the browser`);
  const { seed, ...options } = secret;
  const periodMs = secret.periodSeconds * MS_PER_SECOND;
  if (Math.floor(Date.now() / periodMs) === ctx.usedWindow) await sleep(periodMs - (Date.now() % periodMs));
  const code = await codeForUse(seed, Date.now, sleep, options);
  ctx.usedWindow = Math.floor(Date.now() / periodMs);
  return code;
}

/** The text for one field, read from where its source says at the moment it is typed. The loop never held it. */
async function valueFor(source: FieldSource, action: TypeAction, { block, ctx }: { block: LoginBlockPlan, ctx: LoopContext }): Promise<string> {
  if (source === "identifier") return readCredential(block.usernameEnv, ctx.env);
  if (source === "password") return readCredential(block.passwordEnv, ctx.env);
  if (source === "one-time-code") return freshCode(block, ctx);
  return String(action.organization); // the flow's own word for its organization: a name, not a secret
}

/** Type each field, asking the origin BEFORE each one (a page can move on its own since the last look), then submit. */
async function typeFields(action: TypeAction, { block, ctx }: { block: LoginBlockPlan, ctx: LoopContext }) {
  let last: number | undefined;
  for (const { target, source } of action.fields) {
    await assertStillOnOrigin(ctx.driver, ctx.origin, "the login screens", ctx.idpOrigins);
    last = handleOf(target, ctx);
    await ctx.driver.fill(last, await valueFor(source, action, { block, ctx }));
  }
  if (action.submit !== undefined) return ctx.driver.click(handleOf(action.submit, ctx));
  if (last === undefined || ctx.driver.pressEnter === undefined) {
    throw loginFailed("unbindable-field", "the login screens", "the form has no button to press and no field to press Enter in");
  }
  return ctx.driver.pressEnter(last);
}

/** One action of the loop, marked by screen and kind only: a mark is echoed by `/progress`, so it names no value and no control text. */
async function carryOut(action: Action, { block, ctx }: { block: LoginBlockPlan, ctx: LoopContext }) {
  if (action.kind === "stop") return;
  const screen = ctx.lastSeen === undefined ? "unknown" : classifyScreen(ctx.lastSeen);
  ctx.mark("authScreen", { screen, action: action.kind, ...(action.kind === "type" ? { fields: action.fields.map((field) => field.source) } : {}) });
  if (action.kind === "type") return typeFields(action, { block, ctx });
  await assertStillOnOrigin(ctx.driver, ctx.origin, "the login screens", ctx.idpOrigins);
  return ctx.driver.click(handleOf(action.target, ctx));
}

/**
 * What the loop ended with, as the closed fault list says it: a bot check is `auth-challenge-detected` (named, never answered), and
 * the rest are `auth-login-failed` carrying the outcome as the reason and the CLI's sentence as the detail. A page nobody recognised, or
 * one that never reached the check, is looked at for a CAPTCHA widget first, as a failed step is.
 * @param {LoopResult} result @param {AuthDriver} driver
 */
async function loginEnded(result: LoopResult, driver: AuthDriver) {
  const outcome = result.outcome as LoginOutcome;
  const detail = `${result.remedy ?? ""}${result.flowsStep === undefined ? "" : ` ${result.flowsStep}`}`;
  if (outcome === "bot-challenge") {
    return captureFault(FAULT.AUTH_CHALLENGE_DETECTED, "the login stopped at a bot check, and this run names one and never answers one: it is there to "
      + `stop automated sign-ins, and nothing here will click it, wait it out or work around it. ${detail}`);
  }
  if (outcome === "unknown-screen" || outcome === "signed-in-check-never-matched") {
    return explainFailure(driver, outcome, "the login screens", detail);
  }
  return loginFailed(outcome, "the login screens", detail);
}

/**
 * The login, by screens: load the login page, refuse a check the signed-out page already satisfies (before any value is typed), then
 * loop. Returns how many screens were acted on, for the `authApplied` mark.
 * @param {LoginBlockPlan} block @param {Omit<LoopContext, "handles">} context @returns {Promise<number>}
 */
async function signInByScreens(block: LoginBlockPlan, context: Omit<LoopContext, "handles">): Promise<number> {
  const ctx: LoopContext = { ...context, handles: new WeakMap() };
  const loaded = await ctx.driver.navigate(block.url);
  if (!loaded.ok) throw loginFailed("expect-not-met", "the login page", `${block.url} could not be loaded (${loaded.error ?? "no reason given"})`);
  if ((await observeScreen(block, ctx)).signedIn) {
    throw loginFailed("signed-in-check-matches-signed-out", "the login page", CHECK_MATCHES_SIGNED_OUT);
  }
  const result = await runLoop({
    observe: () => observeScreen(block, ctx),
    act: (action) => carryOut(action, { block, ctx }),
    pause: sleep,
    now: Date.now,
    budgetMillis: ctx.budgetMs,
    config: { ...(block.organization === undefined ? {} : { organization: block.organization }), totpSeedConfigured: totpSecretFor(block, ctx.env) !== undefined },
  });
  if (result.outcome !== "signed-in") throw await loginEnded(result, ctx.driver);
  return result.branches.length;
}

/**
 * A successful login followed by the login form on the requested page: the session did not hold. The screen loop's counterpart of
 * `assertNotShownLoginWall`, which needs the steps' field names; here the wall is a page that asks for an identifier AND a password.
 * A page with an identifier alone is not the wall (a settings page has an email box).
 * @param {AuthDriver} driver
 */
async function assertNotShownLoginScreen(driver: AuthDriver) {
  const { controls, headings } = await readScreen(driver, await driver.axNodes());
  if (classifyScreen({ controls, headings, signedIn: false }) !== "identifier-and-password") return;
  throw captureFault(FAULT.AUTH_SESSION_LOST, "the login succeeded, and then the requested page showed the login form: it asks for an identifier "
    + "and a password. The session did not hold, so this page was not examined as the product.");
}

/**
 * The whole sign-in: the login, then the flow to its capture point, then the requested page.
 *
 * `authApplied` is decided by the CALLER, and only after this returns: a worker that never reaches the end of
 * this function must not say it applied a login.
 *
 * **With `plan.state` the saved state signs in instead of the login's steps** (`signInFromState`); its entries were read from
 * the file by this process (`withLoadedState`), never received.
 *
 * @param {{ plan: AuthPlan, url: string, driver: AuthDriver, env: Record<string, string | undefined>,
 *   mark: (event: string, detail: Record<string, unknown>) => void, bindTimeoutMs?: number,
 *   land?: (url: string) => Promise<{ ok: boolean, error?: string }> }} request
 *   `land` navigates to the requested page once signed in. The worker passes the navigation its own capture path
 *   uses (`navigateExisting`), which records where redirects landed for `assertLandedOnRequestedPage`; without one
 *   the driver's own navigation is used, which is what the tests do.
 */
export async function signIn({ plan, url, driver, env, mark, bindTimeoutMs = BIND_TIMEOUT_MS, land, loopBudgetMs = LOGIN_LOOP_BUDGET_MS }: {
        plan: AuthPlan; url: string; driver: AuthDriver; env: Record<string, string | undefined>;
        mark: (event: string, detail: Record<string, unknown>) => void; bindTimeoutMs?: number;
        land?: (url: string) => Promise<{ ok: boolean; error?: string; }>; loopBudgetMs?: number;
    }) {
  const state = plan.state?.entries;
  if (plan.state !== undefined && state === undefined) throw new Error("a plan that names a saved state needs its entries read from the file first (withLoadedState)");
  const origin = new URL(url).origin;
  const flow = plan.flow.slice(0, plan.upTo);
  /** @param {Step[]} steps @param {"login" | "flow"} phase @returns {RunContext} */
  const run = (steps: Step[], phase: "login" | "flow"): RunContext => ({ steps, origin, driver, env, mark, phase, bindTimeoutMs, idpOrigins: plan.idpOrigins ?? [] });
  let loginUnits = state === undefined ? plan.login.length : 1;
  if (plan.loginBlock !== undefined) {
    loginUnits = await signInByScreens(plan.loginBlock, { driver, origin, env, mark, idpOrigins: plan.idpOrigins ?? [], budgetMs: loopBudgetMs });
  } else if (state === undefined) await runSteps(run(plan.login, "login"));
  else await signInFromState(state, run(plan.login, "login"), url);
  await runSteps(run(flow, "flow"));
  await loadRequestedPage({ driver, url, land, idpOrigins: state === undefined ? plan.idpOrigins ?? [] : [] }); // a saved state signs in on the page's own load
  await assertStillOnOrigin(driver, origin, "the requested page");
  if (plan.loginBlock === undefined) await assertNotShownLoginWall(driver, plan.login);
  else await assertNotShownLoginScreen(driver);
  mark("authApplied", { steps: loginUnits + flow.length });
}

/**
 * A literal typed into a password-type input, in ANY flow, is `auth-literal-secret` (the row's clause 2). Whether an
 * input is a password input is a fact about the PAGE, so it is decided here, where the input is in hand. Names the
 * field and never the value. The CLI's own copy is `assertLiteralIsNotSecret` in `flows.ts`.
 *
 * @param {{ fill: { field: string, value?: string, fromEnv?: string } }} step @param {{ inputType: string }} control
 */
export function assertLiteralIsNotSecret(step: { fill: { field: string; value?: string; fromEnv?: string; }; }, control: { inputType: string; }) {
  if (step.fill.value === undefined || control.inputType.toLowerCase() !== "password") return;
  throw captureFault(FAULT.AUTH_LITERAL_SECRET,
    `fill: on "${step.fill.field}" types a literal into a password field. A password is never written in a flows file; `
    + "name the environment variable with from-env: instead.");
}

/**
 * The purge after EVERY authenticated capture, success or failure (amendment 4 and the ADR's "A session does not
 * outlive its capture"): cookies and storage for the origin are cleared, and the caller then closes the browser.
 * A cleared browser that is left open would still hold the debugging port; a closed browser that was never cleared
 * would leave the session in a PROFILE THAT PERSISTS ON DISK. Both halves, and this is the first.
 *
 * @param {AuthDriver} driver @param {string} url
 */
export async function purgeSession(driver: AuthDriver, url: string) {
  await driver.purge(new URL(url).origin);
}

// ---------------------------------------------------------------------------------------------------------------
// The CDP driver: the browser protocol on the worker's own loopback DevTools port.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {string} webSocketUrl
 * @returns {Promise<{ send: (method: string, params?: object) => Promise<any>, waitFor: (method: string, ms: number) => Promise<any>, close: () => void }>}
 */
function openSession(webSocketUrl: string): Promise<{ send: (method: string, params?: object) => Promise<Untyped>; waitFor: (method: string, ms: number) => Promise<Untyped>; close: () => void; }> {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending: Map<number, { resolve: (value: Untyped) => void; reject: (error: Error) => void; }> = new Map();
  const listeners: Set<(message: Untyped) => void> = new Set();
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch (error) { void error; return; }
    const waiting = message.id === undefined ? undefined : pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`CDP error: ${message.error.message}`));
      else waiting.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP: the socket did not open")), CDP_CALL_TIMEOUT_MS);
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP socket error")); }, { once: true });
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send: (method, params = {}) => new Promise((ok, fail) => {
          const id = nextId++;
          const timeout = setTimeout(() => { pending.delete(id); fail(new Error(`CDP: no reply to ${method}`)); }, CDP_CALL_TIMEOUT_MS);
          pending.set(id, {
            resolve: (value) => { clearTimeout(timeout); ok(value); },
            reject: (error) => { clearTimeout(timeout); fail(error); },
          });
          socket.send(JSON.stringify({ id, method, params }));
        }),
        waitFor: (method, ms) => new Promise((ok, fail) => {
          const timeout = setTimeout(() => { listeners.delete(listener); fail(new Error(`CDP: no ${method} within ${ms} ms`)); }, ms);
          const listener = (message: Untyped) => {
            if (message.method !== method) return;
            clearTimeout(timeout);
            listeners.delete(listener);
            ok(message.params);
          };
          listeners.add(listener);
        }),
        close: () => { try { socket.close(); } catch (error) { void error; } },
      });
    }, { once: true });
  });
}

/**
 * `/json/list`, asked again for as long as the connection is REFUSED.
 *
 * `openPage` returns the moment Edge is spawned, and Edge opens its DevTools port about half a second later (a bare
 * fetch loop read refused at +45 ms and +312 ms and 200 at +657 ms), so a single ask never reaches it: on a real worker
 * every authenticated capture failed with `ECONNREFUSED` before the login began (#2475). Only a refusal means "not
 * listening yet". Any other failure, and any HTTP status, is a real answer and surfaces at once. The bound is the
 * one the reusable launch gives the same port (`CDP_READY_TIMEOUT_MS`): a browser that has not listened in a minute is
 * broken, not busy.
 *
 * @param {number} port @param {number} readyTimeoutMs @returns {Promise<Response>}
 */
async function listTargetsOnceListening(port: number, readyTimeoutMs: number): Promise<Response> {
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    try {
      return await fetch(`http://${CDP_HOST}:${port}/json/list`, { signal: AbortSignal.timeout(CDP_CALL_TIMEOUT_MS) });
    } catch (error) {
      if ((error as Untyped)?.cause?.code !== "ECONNREFUSED") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`CDP: the DevTools port ${port} did not open within ${readyTimeoutMs} ms (connection refused)`, { cause: error });
      }
      await sleep(POLL_MS);
    }
  }
}

/**
 * The page target on the worker's own DevTools port. The port is LOOPBACK BY CONSTRUCTION here — `CDP_HOST` is a
 * constant this module never takes from a request — and `browser-args.test.ts` asserts the launch arguments carry
 * no `--remote-debugging-address` at all (amendment 4), so nothing listens beyond it.
 *
 * @param {number} port @param {number} readyTimeoutMs @returns {Promise<string>}
 */
async function pageSocketUrl(port: number, readyTimeoutMs: number): Promise<string> {
  const response = await listTargetsOnceListening(port, readyTimeoutMs);
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  const targets = (await response.json() as { type?: string, url?: string, webSocketDebuggerUrl?: string }[]);
  const page = targets.find((target) => target.type === "page" && !String(target.url).startsWith("devtools://"));
  if (!page?.webSocketDebuggerUrl) throw new Error("CDP listed no page target to drive");
  return page.webSocketDebuggerUrl;
}

/** @param {any} node @returns {AxNode} */
function axNodeOf(node: Untyped): AxNode {
  return {
    id: String(node.nodeId), role: String(node.role?.value ?? ""), name: String(node.name?.value ?? ""),
    parentId: node.parentId === undefined ? undefined : String(node.parentId),
    backendId: node.backendDOMNodeId, ignored: Boolean(node.ignored),
  };
}

/** The fixed function a `choose` step is carried out by, handed the option's label as DATA: nothing a flow says is spliced into it. */
const CHOOSE_OPTION_FUNCTION = `function (wanted) {
  const options = Array.from(this.options || []);
  const at = options.findIndex((o) => (o.label || o.text || '').replace(/\\s+/g, ' ').trim() === wanted);
  if (at < 0) return false;
  this.selectedIndex = at;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/**
 * The browser protocol behind `AuthDriver`. Every action goes through fixed protocol calls or a FIXED function
 * declaration handed its arguments as data (`Runtime.callFunctionOn`'s `arguments`), so nothing a flow says is ever
 * spliced into script text.
 *
 * `readyTimeoutMs` is how long the port gets to open; a test shortens it, and nothing on the wire can.
 *
 * @param {{ port: number, readyTimeoutMs?: number }} where
 * @returns {Promise<AuthDriver>}
 */
export async function openCdpDriver({ port, readyTimeoutMs = CDP_READY_TIMEOUT_MS }: { port: number; readyTimeoutMs?: number; }): Promise<AuthDriver> {
  const session = await openSession(await pageSocketUrl(port, readyTimeoutMs));
  await session.send("Page.enable");
  await session.send("DOM.enable");
  const objectOf = async (backendNodeId: number) =>
    (await session.send("DOM.resolveNode", { backendNodeId })).object.objectId;
  const callOn = async (handle: number, functionDeclaration: string, args: unknown[] = []) =>
    (await session.send("Runtime.callFunctionOn", {
      objectId: await objectOf(handle), functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true,
    })).result?.value;
  return {
    async navigate(url) {
      const loaded = session.waitFor("Page.loadEventFired", NAVIGATE_TIMEOUT_MS);
      loaded.catch(() => undefined);
      const { errorText } = await session.send("Page.navigate", { url });
      if (errorText) return { ok: false, error: errorText };
      try { await loaded; } catch (error) { return { ok: false, error: (error as Error).message }; }
      return { ok: true };
    },
    async origin() {
      const { result } = await session.send("Runtime.evaluate", { expression: "location.origin", returnByValue: true });
      return String(result?.value ?? "");
    },
    async url() {
      const { result } = await session.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      return String(result?.value ?? "");
    },
    async axNodes() {
      const { nodes } = await session.send("Accessibility.getFullAXTree");
      return nodes.map(axNodeOf);
    },
    async frameSources() {
      const { result } = await session.send("Runtime.evaluate", { expression: FRAME_SOURCES_EXPRESSION, returnByValue: true });
      if (!Array.isArray(result?.value)) throw new Error("the browser did not return a list of frames"); // explainFailure records this
      return result.value;
    },
    inputType: (handle) => callOn(handle, "function () { return this.type === undefined ? '' : String(this.type); }"),
    async fill(handle, text) {
      await session.send("DOM.focus", { backendNodeId: handle });
      await callOn(handle, "function () { if (typeof this.select === 'function') this.select(); }");
      await session.send("Input.insertText", { text });
    },
    choose: (handle, option) => callOn(handle, CHOOSE_OPTION_FUNCTION, [option]),
    isChecked: (handle) => callOn(handle, "function () { return Boolean(this.checked) || this.getAttribute('aria-checked') === 'true'; }"),
    click: async (handle) => { await callOn(handle, "function () { this.click(); }"); },
    autocompleteOf: async (handle) => String(await callOn(handle, "function () { return this.getAttribute('autocomplete') || ''; }") ?? ""),
    async pressEnter(handle) {
      await session.send("DOM.focus", { backendNodeId: handle });
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    },
    setCookies: async (cookies) => { await session.send("Network.setCookies", { cookies: cookies.map(cookieParam) }); },
    async setLocalStorage(entries) {
      const { result } = await session.send("Runtime.evaluate", { expression: "globalThis" });
      await session.send("Runtime.callFunctionOn", {
        objectId: result.objectId, functionDeclaration: SET_LOCAL_STORAGE_FUNCTION, arguments: [{ value: entries }], returnByValue: true,
      });
    },
    async purge(origin) {
      await session.send("Network.enable");
      await session.send("Network.clearBrowserCookies");
      await session.send("Network.clearBrowserCache");
      await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    },
    close: async () => session.close(),
  };
}
