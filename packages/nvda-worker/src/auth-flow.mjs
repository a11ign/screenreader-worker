// @ts-check
/**
 * The worker's half of an authenticated capture — ADR 0038, clauses 1, 3 and 4, and amendment 4.
 *
 * A capture request may carry `auth: { login, flow?, upTo?, state? }`: named steps whose secrets are environment-variable
 * NAMES (`fromEnv`), never values. **This worker reads those variables from its own process environment**, logs in
 * to the page through the browser protocol, replays the requested flow to the capture point, and only then does
 * the capture proper begin. Nothing about a login crosses the wire but the steps and the names, and nothing
 * derived from a session ever leaves this process: the session is destroyed after the capture (`purgeSession`).
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

import { CDP_READY_TIMEOUT_MS } from "./browser-session.mjs";
import { captureFault, FAULT, faultCode } from "./capture-faults.mjs";

/** The closed vocabulary. Same seven as `flows.ts`, in the same order; pinned equal by a test. */
export const FLOW_VERBS = ["goto", "fill", "choose", "check", "press", "expect", "capture"];
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

/** @typedef {{ field: string, within?: string, nth?: number }} ControlRef */
/**
 * @typedef {{ goto: string }
 *   | { fill: ControlRef & { value?: string, fromEnv?: string } }
 *   | { choose: ControlRef & { option: string } }
 *   | { check: ControlRef & { checked: boolean } }
 *   | { press: { control: string, within?: string, nth?: number } }
 *   | { expect: { kind: "heading" | "control" | "text", name: string, timeoutSeconds: number } }
 *   | { capture: string }} Step
 * @typedef {{ name: string, value: string, domain: string, path?: string, expires?: number, httpOnly?: boolean, secure?: boolean, sameSite?: string }} StateCookie
 * @typedef {{ cookies: (StateCookie & { place: number })[], localStorage: { place: number, name: string, value: string }[] }} StateEntries
 * @typedef {{ login: Step[], flow: Step[], upTo: number, state?: { path: string, entries?: StateEntries } }} AuthPlan
 */

/** A request the worker refuses to act on: a 400, not a capture. Carries no value, because none was read yet. */
export class AuthRequestError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AuthRequestError";
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const isName = (value) => typeof value === "string" && value.trim() !== "";

/**
 * @param {Record<string, unknown>} entry @param {string[]} allowed @param {string} where
 */
function refuseUnknownKeys(entry, allowed, where) {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) throw new AuthRequestError(`${where} has ${key}, which the worker does not define`);
  }
}

/** @param {Record<string, unknown>} entry @param {string} where @returns {ControlRef} */
function controlRef(entry, where) {
  if (!isName(entry.field)) throw new AuthRequestError(`${where} has no field name`);
  if (entry.within !== undefined && !isName(entry.within)) throw new AuthRequestError(`${where}: within must be a name`);
  if (entry.nth !== undefined && (!Number.isInteger(entry.nth) || /** @type {number} */ (entry.nth) < 1)) {
    throw new AuthRequestError(`${where}: nth counts from 1`);
  }
  return {
    field: entry.field,
    ...(entry.within === undefined ? {} : { within: /** @type {string} */ (entry.within) }),
    ...(entry.nth === undefined ? {} : { nth: /** @type {number} */ (entry.nth) }),
  };
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function fillStep(raw, where) {
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
function expectStep(raw, where) {
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
 * @param {unknown} raw @param {string} origin @param {string} where @returns {Step}
 */
function validateStep(raw, origin, where) {
  if (!isObject(raw) || Object.keys(raw).length !== 1) {
    throw new AuthRequestError(`${where} must be a mapping with exactly one verb`);
  }
  const [verb, body] = Object.entries(raw)[0];
  switch (verb) {
    case "goto": return { goto: gotoTarget(body, origin, where) };
    case "fill": return fillStep(body, where);
    case "choose": return chooseStep(body, where);
    case "check": return checkStep(body, where);
    case "press": return pressStep(body, where);
    case "expect": return expectStep(body, where);
    case "capture":
      if (!isName(body)) throw new AuthRequestError(`${where}: capture needs a name`);
      return { capture: body };
    default: throw new AuthRequestError(`${where}: ${verb} is not a step; the vocabulary is closed`);
  }
}

/** @param {unknown} body @param {string} origin @param {string} where */
function gotoTarget(body, origin, where) {
  if (!isName(body)) throw new AuthRequestError(`${where}: goto needs a path`);
  let resolved;
  try { resolved = new URL(body, origin); } catch { resolved = null; }
  // Resolved and compared by parsed origin, never by prefix: `//evil.test/x` begins like the origin and leaves it.
  if (resolved === null || resolved.origin !== origin) throw new AuthRequestError(`${where}: goto leaves ${origin}`);
  return body;
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function chooseStep(raw, where) {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: choose takes a mapping`);
  refuseUnknownKeys(raw, ["field", "within", "nth", "option"], `${where}: choose`);
  const ref = controlRef(raw, `${where}: choose`);
  if (!isName(raw.option)) throw new AuthRequestError(`${where}: choose on "${ref.field}" has no option`);
  return { choose: { ...ref, option: raw.option } };
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function checkStep(raw, where) {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: check takes a mapping`);
  refuseUnknownKeys(raw, ["field", "within", "nth", "checked"], `${where}: check`);
  const ref = controlRef(raw, `${where}: check`);
  if (raw.checked !== undefined && typeof raw.checked !== "boolean") throw new AuthRequestError(`${where}: checked is a boolean`);
  return { check: { ...ref, checked: raw.checked !== false } };
}

/** @param {unknown} raw @param {string} where @returns {Step} */
function pressStep(raw, where) {
  if (!isObject(raw)) throw new AuthRequestError(`${where}: press takes a mapping`);
  refuseUnknownKeys(raw, ["control", "within", "nth"], `${where}: press`);
  const { field, ...rest } = controlRef({ ...raw, field: raw.control }, `${where}: press`);
  return { press: { control: field, ...rest } };
}

/**
 * @param {unknown} steps @param {string} origin @param {string} label
 * @returns {Step[]}
 */
function validateSteps(steps, origin, label) {
  if (!Array.isArray(steps)) throw new AuthRequestError(`auth.${label} must be a list of steps`);
  if (steps.length > MAX_STEPS) throw new AuthRequestError(`auth.${label} has more than ${MAX_STEPS} steps`);
  return steps.map((step, index) => validateStep(step, origin, `auth.${label} step ${index + 1}`));
}

/**
 * Validate a request's `auth` again, at THIS boundary, because it arrives over HTTP from anywhere.
 *
 * The login flow is held to the rules a login is held to in `flows.ts`: `fromEnv` only (a literal in a login is
 * a password committed to somebody's file), ends in `expect`, captures nothing. `upTo` counts into `flow`.
 *
 * @param {unknown} raw @param {string} url the capture's URL, whose origin every `goto` is pinned to
 * @returns {AuthPlan}
 */
export function validateAuthRequest(raw, url) {
  if (!isObject(raw)) throw new AuthRequestError("auth must be a mapping with a login");
  refuseUnknownKeys(raw, ["login", "flow", "upTo", "state"], "auth");
  let origin;
  try { origin = new URL(url).origin; } catch { throw new AuthRequestError("auth needs a capture url to pin its origin to"); }
  const login = validateSteps(raw.login, origin, "login");
  if (login.length === 0) throw new AuthRequestError("auth.login has no steps");
  login.forEach((step, index) => {
    const where = `auth.login step ${index + 1}`;
    if ("fill" in step && step.fill.fromEnv === undefined) {
      throw new AuthRequestError(`${where}: a login's fill takes fromEnv only, never a literal`);
    }
    if ("capture" in step) throw new AuthRequestError(`${where}: a login captures nothing`);
  });
  if (!("expect" in login[login.length - 1])) throw new AuthRequestError("auth.login must end with expect");
  const flow = raw.flow === undefined ? [] : validateSteps(raw.flow, origin, "flow");
  const upTo = raw.upTo === undefined ? flow.length : raw.upTo;
  if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 0 || upTo > flow.length) {
    throw new AuthRequestError("auth.upTo must be a step index within auth.flow");
  }
  return raw.state === undefined ? { login, flow, upTo } : { login, flow, upTo, state: stateRef(raw.state) };
}

/**
 * `auth.state`: an absolute path and nothing else (amendment 7, choice 5). The value is never echoed in a refusal, since a
 * request that put something other than a path here may have put a value here.
 * @param {unknown} raw @returns {{ path: string }}
 */
function stateRef(raw) {
  if (!isObject(raw)) throw new AuthRequestError("auth.state must be a mapping with a path");
  refuseUnknownKeys(raw, ["path"], "auth.state");
  if (typeof raw.path !== "string" || !isAbsolute(raw.path)) throw new AuthRequestError("auth.state.path must be an absolute path");
  return { path: raw.path };
}

/** Every environment-variable NAME a plan reads, so a missing one is found before any browser opens. */
/** @param {AuthPlan} plan @returns {string[]} */
export function requiredEnvNames(plan) {
  // A state run never executes the login's steps (only its final `expect:`), so it reads none of the login's variables.
  const steps = plan.state === undefined ? [...plan.login, ...plan.flow.slice(0, plan.upTo)] : plan.flow.slice(0, plan.upTo);
  const names = steps.flatMap((step) => ("fill" in step && step.fill.fromEnv !== undefined ? [step.fill.fromEnv] : []));
  return [...new Set(names)];
}

/**
 * The value of a variable, or `auth-credential-missing` naming the variable and never a value.
 * @param {string} name @param {Record<string, string | undefined>} env @returns {string}
 */
export function readCredential(name, env) {
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
export function assertCredentialsPresent(plan, env) {
  for (const name of requiredEnvNames(plan)) readCredential(name, env);
}

// ---------------------------------------------------------------------------------------------------------------
// A saved storage state (ADR 0038, amendment 7). DUPLICATED from `packages/cli/src/auth/state-file.ts` and `scrub.ts`
// (`stateEntriesFor`), because this file cannot import them; `interpreter.test.ts` runs one table through both.
// ---------------------------------------------------------------------------------------------------------------

const SAME_SITE = ["Strict", "Lax", "None"];

/** @param {unknown} cookie @param {string} at @returns {string | undefined} why one cookie is not a cookie: names a field, never a value */
function cookieProblem(cookie, at) {
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
  if (cookie.sameSite !== undefined && !SAME_SITE.includes(/** @type {string} */ (cookie.sameSite))) return `${at} has a "sameSite" that is not Strict, Lax or None`;
  return undefined;
}

/** @param {unknown} entry @param {string} at @returns {string | undefined} */
function originProblem(entry, at) {
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
export function stateShapeProblem(raw) {
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
function cookieCoversHost(domain, host) {
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
export function stateEntriesFor(state, origin) {
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
export function loadStateEntries(path, url, readText) {
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
export function withLoadedState(plan, url, readText = (path) => readFileSync(path, "utf8")) {
  if (plan.state === undefined) return plan;
  return { ...plan, state: { path: plan.state.path, entries: loadStateEntries(plan.state.path, url, readText) } };
}

/**
 * The capture options an `auth` request decides — everything about authentication that `captureOptions` (in
 * `server.mjs`, which needs a screen reader to import and so has no test) would otherwise decide inline.
 *
 * With `auth`: the plan, validated AGAIN here (it arrives over HTTP from anywhere), its saved state (if it names one) read
 * and validated by THIS process, every variable it reads checked present in THIS process's environment before anything is launched, and `reuseBrowser` FORCED OFF whatever
 * the request or the fleet default says — a reused browser keeps its renderer, so a session left in it would be the
 * next capture's session. Without `auth`: nothing, which is every request an older host sends.
 *
 * @param {{ parsed: { auth?: unknown, url: string }, env: Record<string, string | undefined> }} request
 * @returns {{ auth?: AuthPlan, reuseBrowser?: false }}
 */
export function authOptionsFor({ parsed, env }) {
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
export function authAcknowledgement({ auth, marks }) {
  return auth !== undefined && marks.some((mark) => mark.event === "authApplied") ? { authApplied: true } : {};
}

/**
 * How the result store holds a capture's response: an authenticated one for ONE delivery (`capture-results.mjs`),
 * everything else exactly as it always was.
 *
 * @param {{ auth?: AuthPlan }} opts @returns {{ deliverOnce: boolean }}
 */
export function retentionFor(opts) {
  return { deliverOnce: opts.auth !== undefined };
}

/** `127.0.0.0/8`, `::1` and `::ffff:127.x`, as a socket reports its peer. An SSH tunnel presents as loopback (ADR 0038). */
/** @param {string | undefined} address */
export function isLoopbackPeer(address) {
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
export function authGate({ auth, peer }) {
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

/** @typedef {{ id: string, role: string, name: string, parentId?: string, backendId?: number, ignored: boolean }} AxNode */

const FILL_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];
const CHECK_ROLES = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"];
const CHOOSE_ROLES = ["combobox", "listbox"];
const PRESS_ROLES = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "switch",
  "checkbox", "radio", "option"];

/** @param {unknown} text */
export const normalise = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * @param {AxNode[]} nodes @param {{ roles: string[], name: string, within?: string }} query @returns {AxNode[]}
 */
export function controlsNamed(nodes, { roles, name, within }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const wanted = normalise(name);
  const inside = (/** @type {AxNode} */ node) => {
    if (within === undefined) return true;
    for (let up = node.parentId ? byId.get(node.parentId) : undefined; up; up = up.parentId ? byId.get(up.parentId) : undefined) {
      if (normalise(up.name) === normalise(within)) return true;
    }
    return false;
  };
  return nodes.filter((node) => !node.ignored && roles.includes(node.role) && normalise(node.name) === wanted && inside(node));
}

/** @param {AxNode[]} nodes @param {{ kind: "heading" | "control" | "text", name: string }} expected */
export function expectationMet(nodes, { kind, name }) {
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

/**
 * What the interpreter needs from a browser. Two implementations exist or will: the CDP driver below, and
 * Playwright in the CLI (PR 5). Handles are opaque to the interpreter.
 *
 * @typedef {{
 *   navigate(url: string): Promise<{ ok: boolean, error?: string }>,
 *   origin(): Promise<string>,
 *   axNodes(): Promise<AxNode[]>,
 *   inputType(handle: number): Promise<string>,
 *   fill(handle: number, text: string): Promise<void>,
 *   choose(handle: number, option: string): Promise<boolean>,
 *   frameSources(): Promise<string[]>,
 *   isChecked(handle: number): Promise<boolean>,
 *   click(handle: number): Promise<void>,
 *   setCookies(cookies: StateCookie[]): Promise<void>,
 *   setLocalStorage(entries: { name: string, value: string }[]): Promise<void>,
 *   purge(origin: string): Promise<void>,
 *   close(): Promise<void>,
 * }} AuthDriver
 */

/**
 * `auth-login-failed`, with the reason, the step and the verb — and no value. `where` and `detail` stay on the error: a
 * saved-state run states the same fact and gives different advice (`stateExpired`).
 * @param {"expect-not-met" | "unbindable-field" | "left-origin"} reason @param {string} where @param {string} detail @param {string} [advice]
 */
function loginFailed(reason, where, detail, advice) {
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
export function challengeVendor(sources) {
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
 * @param {"expect-not-met" | "unbindable-field"} reason @param {string} where @param {string} detail
 */
async function explainFailure(driver, reason, where, detail) {
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

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `attempt` returns something other than undefined, or the bound passes. A wait for a CONDITION, with a
 * deadline: never a fixed sleep (the vocabulary has none, and this is what its `expect` is).
 *
 * @template T
 * @param {() => Promise<T | undefined>} attempt @param {number} boundMs
 * @returns {Promise<T | undefined>}
 */
async function until(attempt, boundMs) {
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
async function bindControl(driver, query, where, boundMs) {
  /** @type {AxNode[]} */
  let seen = [];
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
async function currentOrigin(driver) {
  /** @type {unknown} */
  let last;
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
export function landedOnLoginForm(nodes, login) {
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
async function assertNotShownLoginWall(driver, login) {
  if (!landedOnLoginForm(await driver.axNodes(), login)) return;
  const names = login.flatMap((step) => ("fill" in step ? [`"${step.fill.field}"`] : []));
  throw captureFault(FAULT.AUTH_SESSION_LOST, "the login succeeded, and then the requested page showed the login form: every field the "
    + `login fills (${[...new Set(names)].join(", ")}) is on the page the run landed on. The session did not hold, so this page was `
    + "not examined as the product.");
}

/** @param {AuthDriver} driver @param {string} origin @param {string} where */
async function assertStillOnOrigin(driver, origin, where) {
  const now = await currentOrigin(driver);
  if (now !== origin) {
    throw loginFailed("left-origin", where, `the page is on ${now}, not ${origin}`,
      "A redirect to an identity provider is SSO, which v1 does not do: use a dedicated test account without MFA or SSO.");
  }
}

/**
 * @typedef {{ steps: Step[], origin: string, driver: AuthDriver, env: Record<string, string | undefined>,
 *   mark: (event: string, detail: Record<string, unknown>) => void, phase: "login" | "flow", bindTimeoutMs: number }} RunContext
 */

/** @param {Step} step @returns {string} the step's verb, and never a value */
const verbOf = (step) => /** @type {string} */ (Object.keys(step)[0]);

/**
 * @param {Step} step @param {RunContext} run @param {string} where
 */
async function runStep(step, run, where) {
  const { driver, origin, env, bindTimeoutMs } = run;
  if ("goto" in step) {
    const result = await driver.navigate(new URL(step.goto, origin).href);
    if (!result.ok) throw loginFailed("expect-not-met", where, `${step.goto} could not be loaded (${result.error ?? "no reason given"})`);
  } else if ("fill" in step) {
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
  } else if ("press" in step) {
    const { control, within, nth } = step.press;
    await driver.click(await bindControl(driver, { roles: PRESS_ROLES, name: control, within, nth }, where, bindTimeoutMs));
  } else if ("expect" in step) {
    await expectStepMet(step.expect, run, where);
  }
}

/**
 * @param {{ kind: "heading" | "control" | "text", name: string, timeoutSeconds: number }} expected @param {RunContext} run @param {string} where
 */
async function expectStepMet(expected, run, where) {
  const met = await until(async () => (expectationMet(await run.driver.axNodes(), expected) ? true : undefined),
    expected.timeoutSeconds * MS_PER_SECOND);
  if (!met) {
    throw await explainFailure(run.driver, "expect-not-met", where, `no ${expected.kind} "${expected.name}" appeared within ${expected.timeoutSeconds} s`);
  }
  // A heading on another site is not this site's dashboard: the condition is met only on the pinned origin.
  await assertStillOnOrigin(run.driver, run.origin, where);
}

/**
 * One step, numbered as a person counts: marked by verb and accessible name only, with the origin re-checked after any step
 * that can move the page (`ceo`'s reviewer asked for exactly this: a `press` can redirect off-origin where the parser can
 * only see declared `goto`s). The CLI's own copy is `runNumbered` in `interpreter.ts`.
 *
 * @param {Step} step @param {number} index @param {RunContext} run
 */
async function runNumbered(step, index, run) {
  const verb = verbOf(step);
  const where = `${run.phase} step ${index} (${verb})`;
  if (verb === "capture") return; // a capture point is where the caller stops; it acts on nothing
  const body = /** @type {any} */ (step)[verb];
  run.mark("authStep", { phase: run.phase, index, verb, name: typeof body === "string" ? undefined : body.field ?? body.control ?? body.name });
  await runStep(step, run, where);
  if (verb !== "expect") await assertStillOnOrigin(run.driver, run.origin, where);
}

/** @param {RunContext} run */
export async function runSteps(run) {
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
export function cookieParam(cookie) {
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
async function loadState(state, { url, driver, mark }) {
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
function stateExpired(error) {
  return captureFault(FAULT.AUTH_STATE_EXPIRED, `the saved state did not sign the run in (${error.where}): ${error.detail}`);
}

/**
 * The state stands in for the sign-in: it is loaded, and then the login's FINAL step (its `expect:`) runs on the page the run
 * requested. The login's other steps never run. A CAPTCHA widget on the page still ends `auth-challenge-detected`. The CLI's
 * own copy is `signInFromState` in `interpreter.ts`.
 * @param {StateEntries} state @param {RunContext} run @param {string} url
 */
async function signInFromState(state, run, url) {
  await loadState(state, { url, driver: run.driver, mark: run.mark });
  try {
    await runNumbered(run.steps[run.steps.length - 1], run.steps.length, run);
  } catch (error) {
    const reason = /** @type {{ reason?: string }} */ (error).reason;
    if (faultCode(error) === FAULT.AUTH_LOGIN_FAILED && (reason === "expect-not-met" || reason === "left-origin")) {
      throw stateExpired(/** @type {any} */ (error));
    }
    throw error;
  }
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
export async function signIn({ plan, url, driver, env, mark, bindTimeoutMs = BIND_TIMEOUT_MS, land }) {
  const state = plan.state?.entries;
  if (plan.state !== undefined && state === undefined) throw new Error("a plan that names a saved state needs its entries read from the file first (withLoadedState)");
  const origin = new URL(url).origin;
  const flow = plan.flow.slice(0, plan.upTo);
  /** @param {Step[]} steps @param {"login" | "flow"} phase @returns {RunContext} */
  const run = (steps, phase) => ({ steps, origin, driver, env, mark, phase, bindTimeoutMs });
  if (state === undefined) await runSteps(run(plan.login, "login"));
  else await signInFromState(state, run(plan.login, "login"), url);
  await runSteps(run(flow, "flow"));
  const landed = await (land ?? ((target) => driver.navigate(target)))(url);
  if (!landed.ok) throw loginFailed("expect-not-met", "the requested page", `${url} could not be loaded after the login (${landed.error ?? "no reason given"})`);
  await assertStillOnOrigin(driver, origin, "the requested page");
  await assertNotShownLoginWall(driver, plan.login);
  mark("authApplied", { steps: (state === undefined ? plan.login.length : 1) + flow.length });
}

/**
 * A literal typed into a password-type input, in ANY flow, is `auth-literal-secret` (the row's clause 2). Whether an
 * input is a password input is a fact about the PAGE, so it is decided here, where the input is in hand. Names the
 * field and never the value. The CLI's own copy is `assertLiteralIsNotSecret` in `flows.ts`.
 *
 * @param {{ fill: { field: string, value?: string, fromEnv?: string } }} step @param {{ inputType: string }} control
 */
export function assertLiteralIsNotSecret(step, control) {
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
export async function purgeSession(driver, url) {
  await driver.purge(new URL(url).origin);
}

// ---------------------------------------------------------------------------------------------------------------
// The CDP driver: the browser protocol on the worker's own loopback DevTools port.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {string} webSocketUrl
 * @returns {Promise<{ send: (method: string, params?: object) => Promise<any>, waitFor: (method: string, ms: number) => Promise<any>, close: () => void }>}
 */
function openSession(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  /** @type {Set<(message: any) => void>} */
  const listeners = new Set();
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
          const listener = (/** @type {any} */ message) => {
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
async function listTargetsOnceListening(port, readyTimeoutMs) {
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    try {
      return await fetch(`http://${CDP_HOST}:${port}/json/list`, { signal: AbortSignal.timeout(CDP_CALL_TIMEOUT_MS) });
    } catch (error) {
      if (/** @type {any} */ (error)?.cause?.code !== "ECONNREFUSED") throw error;
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
async function pageSocketUrl(port, readyTimeoutMs) {
  const response = await listTargetsOnceListening(port, readyTimeoutMs);
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  const targets = /** @type {{ type?: string, url?: string, webSocketDebuggerUrl?: string }[]} */ (await response.json());
  const page = targets.find((target) => target.type === "page" && !String(target.url).startsWith("devtools://"));
  if (!page?.webSocketDebuggerUrl) throw new Error("CDP listed no page target to drive");
  return page.webSocketDebuggerUrl;
}

/** @param {any} node @returns {AxNode} */
function axNodeOf(node) {
  return {
    id: String(node.nodeId), role: String(node.role?.value ?? ""), name: String(node.name?.value ?? ""),
    parentId: node.parentId === undefined ? undefined : String(node.parentId),
    backendId: node.backendDOMNodeId, ignored: Boolean(node.ignored),
  };
}

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
export async function openCdpDriver({ port, readyTimeoutMs = CDP_READY_TIMEOUT_MS }) {
  const session = await openSession(await pageSocketUrl(port, readyTimeoutMs));
  await session.send("Page.enable");
  await session.send("DOM.enable");
  const objectOf = async (/** @type {number} */ backendNodeId) =>
    (await session.send("DOM.resolveNode", { backendNodeId })).object.objectId;
  const callOn = async (/** @type {number} */ handle, /** @type {string} */ functionDeclaration, /** @type {unknown[]} */ args = []) =>
    (await session.send("Runtime.callFunctionOn", {
      objectId: await objectOf(handle), functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true,
    })).result?.value;
  return {
    async navigate(url) {
      const loaded = session.waitFor("Page.loadEventFired", NAVIGATE_TIMEOUT_MS);
      loaded.catch(() => undefined);
      const { errorText } = await session.send("Page.navigate", { url });
      if (errorText) return { ok: false, error: errorText };
      try { await loaded; } catch (error) { return { ok: false, error: /** @type {Error} */ (error).message }; }
      return { ok: true };
    },
    async origin() {
      const { result } = await session.send("Runtime.evaluate", { expression: "location.origin", returnByValue: true });
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
    choose: (handle, option) => callOn(handle, `function (wanted) {
      const options = Array.from(this.options || []);
      const at = options.findIndex((o) => (o.label || o.text || '').replace(/\\s+/g, ' ').trim() === wanted);
      if (at < 0) return false;
      this.selectedIndex = at;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`, [option]),
    isChecked: (handle) => callOn(handle, "function () { return Boolean(this.checked) || this.getAttribute('aria-checked') === 'true'; }"),
    click: async (handle) => { await callOn(handle, "function () { this.click(); }"); },
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
