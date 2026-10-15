/**
 * THE SCREEN LOOP, THE WORKER'S COPY (a11ign#4998, part of #4084 v3 login phase 2; the chairman's design direction on #4084,
 * 2026-10-11, item 1 layer 2).
 *
 * The login runs in the worker's browser, so the loop that recognises each screen lives in the worker's interpreter too. There are two
 * interpreters because there cannot be one: the CLI's `packages/cli/src/auth/screen-loop.ts` (a11y-witness #4993) is the SPECIFICATION and
 * this file is a pure copy of it, with the one import it had (`login-outcomes.ts`) inlined as the literals below. `screen-loop.test.ts`
 * repeats the CLI test's cases as literals and imports nothing from there, which is what pins the two together.
 *
 * Auth0 Universal Login shows about 28 prompts depending on tenant settings, and its CSS classes change on every build, so a fixed script
 * breaks and a loop that recognises each screen and acts holds. A screen is recognised by the ACCESSIBLE NAME and `autocomplete` token
 * of its controls and by its headings, never by CSS: a class name is not part of what a person (or a screen reader) is given, and it is
 * the part the provider rebuilds.
 *
 * Three rules keep the loop from doing harm to an account:
 *   - a screen is acted on only when EXACTLY ONE screen matches; two matches wait and re-observe, never guess;
 *   - the screen just acted on is never acted on again until a different screen appears: a form that comes back
 *     unchanged is waited on, because typing a password twice is how a provider locks an account;
 *   - the ending screens (blocked, bot challenge, rate limit, a rejected credential or code) stop at once, and a
 *     login is never retried after one of them.
 *
 * PURE: the observation and the action are plain values and the loop's IO is injected. No browser, no import of `auth-flow.ts`, and no
 * secret: a `type` action names where its value comes from (`source`) and the caller supplies it at the moment of typing, so a fresh
 * one-time code is made then and not here.
 */

/**
 * The outcomes this loop can end with, and the one line a person reads for each. The CLI's `login-outcomes.ts` names fifteen; these are
 * the eleven the loop itself can reach (the rest are the scan's, after the login). The sentences are the CLI's, word for word.
 */
const LOGIN_OUTCOMES = {
  "credentials-rejected": { remedy: "The username or password was refused: check the values the run reads from the environment, and do not retry." },
  "account-blocked": { remedy: "The provider has blocked this account: unblock it there, or sign in with another account." },
  "mfa-required-no-seed": { remedy: "The login asks for a one-time code and no authenticator seed is configured: set the seed the run reads, or sign in from a saved state." },
  "totp-rejected": { remedy: "The one-time code was refused: check the seed matches the authenticator app and the clock is in step, and do not retry." },
  "mfa-enrollment-required": { remedy: "The account must enrol an authenticator app before it can sign in: enrol one with the provider, then run again." },
  "bot-challenge": { remedy: "The provider showed a bot check the run will not answer: sign in from a saved state (--auth-state) taken where the check does not appear." },
  "rate-limited": { remedy: "The provider is rate-limiting sign-in: wait before running again, since a retry now only adds to the limit." },
  "consent-required": { remedy: "The site asks for consent the run will not give: grant it in a saved state (--auth-state) and run again." },
  "organization-required": { remedy: "The provider asks which organization to sign in to, and the run did not name one: name it in the flow, then run again." },
  "unknown-screen": { remedy: "The login reached a screen the run does not recognise: open that page in a browser and make the flow's expect step match it." },
  "signed-in-check-never-matched": { remedy: "The signed-in check never matched after the login: check the flow's signed-in selector against the page the login reaches." },
} as const satisfies Record<string, { readonly remedy: string }>;

export { LOGIN_OUTCOMES };
export type LoginOutcome = keyof typeof LOGIN_OUTCOMES;

/**
 * One control as the caller read it from the accessibility tree. `className` is carried only so a fixture can prove
 * it is NEVER read: the classifier below has no code path that touches it.
 */
export interface ScreenControl {
  readonly role: string;
  readonly name: string;
  readonly autocomplete?: string;
  readonly className?: string;
}

export interface ScreenObservation {
  readonly controls: readonly ScreenControl[];
  readonly headings: readonly string[];
  /** The signed-in check held on this page (`signed-in-check.ts`'s `loginVerdict`): the loop's exit condition. */
  readonly signedIn: boolean;
}

export const FORM_SCREENS = [
  "identifier-and-password",
  "identifier",
  "password",
  "one-time-code",
  "factor-picker",
  "passkey-nudge",
  "mfa-enrollment",
  "stay-signed-in",
  "consent",
  "organization-picker",
  "landing",
] as const;
export type FormScreen = (typeof FORM_SCREENS)[number];

/** Screens the loop ends on at once. Each is named as the outcome it ends with. */
export const ENDING_SCREENS = ["account-blocked", "bot-challenge", "rate-limited", "totp-rejected", "credentials-rejected"] as const;
export type EndingScreen = (typeof ENDING_SCREENS)[number];

export type Screen = FormScreen | EndingScreen;
export type Classification = Screen | "unknown-screen" | "ambiguous";

const INPUT_ROLES = new Set(["textbox", "password", "searchbox"]);
const CHOICE_ROLES = new Set(["button", "link", "radio", "option", "menuitem"]);

const IDENTIFIER_NAME = /^(e-?mail|user ?name|email address|username or email|phone)/i;
const PASSWORD_NAME = /password/i;
const PASSWORD_NOT = /forgot|show|hide|new|confirm|reset/i;
const CODE_NAME = /(one[- ]time|verification|authentication|security) code|enter (the |your )?code/i;
const SUBMIT_NAME = /^(continue|log ?in|sign ?in|submit|next|verify|enter)\b/i;
// `Continue with Google` names an identity provider, not the form: it leaves this login for the provider's own page, so it is
// never the submit. Auth0 enables the Google connection by default, so a real tenant shows it beside the plain `Continue`.
const PROVIDER_NAME = /\b(with|using)\s+(google|apple|microsoft|github|facebook)\b/i;
const EXACT_SUBMIT_NAME = /^(continue|log ?in|sign ?in)$/i;
// The app's own entry button on a page that asks for nothing (`auth0-spa` shows "Sign in required" and one "Sign in").
const LANDING_NAME = /^(sign ?in|log ?in)$/i;
const SKIP_NAME = /^(skip|not now|maybe later|remind me later|no,? thanks|do (this|it) later|continue without)/i;
const FACTOR_NAME = /authenticator|sms|text message|push|e-?mail|security key|recovery code|phone|voice|webauthn/i;
const AUTHENTICATOR_NAME = /authenticator|totp|one-time/i;
const ACCEPT_NAME = /^(accept|allow|authorize|grant)/i;
const NO_NAME = /^(no|not now|don'?t stay signed in)$/i;

const FACTORS_FOR_A_PICKER = 2;

const hasToken = (control: ScreenControl, wanted: string): boolean =>
  (control.autocomplete ?? "").toLowerCase().split(/\s+/).includes(wanted);

const headingMatches = (observation: ScreenObservation, pattern: RegExp): boolean =>
  observation.headings.some((heading) => pattern.test(heading));

const choices = (observation: ScreenObservation, pattern: RegExp): ScreenControl[] =>
  observation.controls.filter((control) => CHOICE_ROLES.has(control.role) && pattern.test(control.name.trim()));

const findPassword = (o: ScreenObservation): ScreenControl | undefined =>
  o.controls.find(
    (c) => hasToken(c, "current-password") || (INPUT_ROLES.has(c.role) && PASSWORD_NAME.test(c.name) && !PASSWORD_NOT.test(c.name)),
  );

const findCode = (o: ScreenObservation): ScreenControl | undefined =>
  o.controls.find((c) => hasToken(c, "one-time-code") || (INPUT_ROLES.has(c.role) && CODE_NAME.test(c.name)));

const findIdentifier = (o: ScreenObservation): ScreenControl | undefined => {
  const password = findPassword(o);
  const code = findCode(o);
  return o.controls.find(
    (c) =>
      c !== password &&
      c !== code &&
      (hasToken(c, "username") || hasToken(c, "email") || (INPUT_ROLES.has(c.role) && IDENTIFIER_NAME.test(c.name.trim()))),
  );
};

const hasInput = (find: (o: ScreenObservation) => ScreenControl | undefined, o: ScreenObservation): boolean => find(o) !== undefined;

/** Every name a person could read on the page, for the endings that can arrive as a heading, a label or an alert. */
const pageTexts = (o: ScreenObservation): string[] => [...o.headings, ...o.controls.map((c) => c.name)];

const alertTexts = (o: ScreenObservation): string[] => o.controls.filter((c) => c.role === "alert").map((c) => c.name);

const anyMatch = (texts: readonly string[], pattern: RegExp): boolean => texts.some((text) => pattern.test(text));

const ENDING_MATCHERS: Record<EndingScreen, (o: ScreenObservation) => boolean> = {
  "account-blocked": (o) => anyMatch(pageTexts(o), /has been blocked|(account|user).{0,30}blocked|blocked.{0,30}(account|user)/i),
  "bot-challenge": (o) => anyMatch(pageTexts(o), /captcha|not a robot|verify (that )?you('re| are) (a )?human|are you human/i),
  "rate-limited": (o) => anyMatch(pageTexts(o), /too many (login |sign.?in )?(attempts|requests)|rate limit/i),
  "totp-rejected": (o) => anyMatch(alertTexts(o), /(invalid|incorrect|wrong|expired).{0,30}code|code.{0,30}(invalid|incorrect|wrong|expired|not valid)/i),
  "credentials-rejected": (o) =>
    anyMatch(alertTexts(o), /(wrong|incorrect|invalid) (e-?mail|username|user name|password|credentials)|email or password/i),
};

const FORM_MATCHERS: Record<FormScreen, (o: ScreenObservation) => boolean> = {
  "identifier-and-password": (o) => hasInput(findIdentifier, o) && hasInput(findPassword, o),
  identifier: (o) => hasInput(findIdentifier, o) && !hasInput(findPassword, o) && !hasInput(findCode, o),
  password: (o) => !hasInput(findIdentifier, o) && hasInput(findPassword, o),
  "one-time-code": (o) => hasInput(findCode, o) && !hasInput(findPassword, o),
  "factor-picker": (o) =>
    choices(o, FACTOR_NAME).length >= FACTORS_FOR_A_PICKER && !hasInput(findPassword, o) && !hasInput(findCode, o),
  "passkey-nudge": (o) => headingMatches(o, /passkey/i),
  "mfa-enrollment": (o) => headingMatches(o, /secure your account|enrol|enroll|set up .*(authenticator|account)|scan .*qr|qr code/i),
  "stay-signed-in": (o) => headingMatches(o, /stay signed in|keep me signed in/i) && choices(o, NO_NAME).length > 0,
  consent: (o) => headingMatches(o, /authorize|requesting access|consent|permission/i) && choices(o, ACCEPT_NAME).length > 0,
  "organization-picker": (o) => headingMatches(o, /organi[sz]ation/i) && !hasInput(findPassword, o),
  // A page with no field and exactly one sign-in control is the app's signed-out page: pressing it starts the login.
  // Two such controls match nothing and end `unknown-screen`, because which one starts the login is not ours to guess.
  landing: (o) =>
    !hasInput(findIdentifier, o) && !hasInput(findPassword, o) && !hasInput(findCode, o) && choices(o, LANDING_NAME).length === 1,
};

const matching = <S extends string>(matchers: Record<S, (o: ScreenObservation) => boolean>, o: ScreenObservation): S[] =>
  (Object.keys(matchers) as S[]).filter((screen) => matchers[screen](o));

/** The forms that type into a field and then press the submit, so a submit that cannot be picked makes them ambiguous. */
const TYPING_FORMS: ReadonlySet<FormScreen> = new Set([
  "identifier-and-password",
  "identifier",
  "password",
  "one-time-code",
  "organization-picker",
]);

/**
 * Which screen is this? An ending screen outranks a form because it is about the same page: an alert saying the code
 * was wrong sits ON the one-time-code form, and acting on that form again is exactly what must not happen. Among
 * forms exactly one must match; none is `unknown-screen`, and more than one is `ambiguous`. A typing form whose submit
 * cannot be told apart from its siblings is `ambiguous` too: the loop waits rather than press one of them by page order.
 */
export function classifyScreen(observation: ScreenObservation): Classification {
  const [ending] = matching(ENDING_MATCHERS, observation);
  if (ending !== undefined) return ending;
  const forms = matching(FORM_MATCHERS, observation);
  const [form] = forms;
  if (forms.length === 1 && !(TYPING_FORMS.has(form) && submitIsAmbiguous(observation))) return form;
  return forms.length === 0 ? "unknown-screen" : "ambiguous";
}

export interface LoopConfig {
  /** `organization:` from the flow, when set: the one the org picker is answered with. */
  readonly organization?: string;
  /** A TOTP seed is configured, so a one-time code can be made. Without one the code screens end the login. */
  readonly totpSeedConfigured: boolean;
}

/** Where a typed value comes from. The loop never holds the value: a code is made at the moment it is typed. */
export type FieldSource = "identifier" | "password" | "one-time-code" | "organization";

export interface FieldFill {
  readonly target: ScreenControl;
  readonly source: FieldSource;
}

export interface TypeAction {
  readonly kind: "type";
  readonly fields: readonly FieldFill[];
  /** The button to press after typing; absent means press Enter in the last field. */
  readonly submit?: ScreenControl;
  /** The value for a field whose source is `organization`: a name from the flow, not a secret. */
  readonly organization?: string;
}

export type Action =
  | TypeAction
  | { readonly kind: "submit"; readonly target: ScreenControl; readonly note?: string }
  | { readonly kind: "skip"; readonly target: ScreenControl; readonly note: string }
  | { readonly kind: "choose"; readonly target: ScreenControl; readonly note?: string }
  | { readonly kind: "stop"; readonly outcome: LoginOutcome; readonly remedy: string };

const stop = (outcome: LoginOutcome): Action => ({ kind: "stop", outcome, remedy: LOGIN_OUTCOMES[outcome].remedy });

const submitCandidates = (o: ScreenObservation): ScreenControl[] =>
  choices(o, SUBMIT_NAME).filter((control) => !PROVIDER_NAME.test(control.name.trim()));

/** The exact name (`Continue`, `Log in`) wins among several candidates; several with none is no submit at all, never the first. */
const submitControl = (o: ScreenObservation): ScreenControl | undefined => {
  const candidates = submitCandidates(o);
  if (candidates.length <= 1) return candidates[0];
  return candidates.find((control) => EXACT_SUBMIT_NAME.test(control.name.trim()));
};

const submitIsAmbiguous = (o: ScreenObservation): boolean => submitCandidates(o).length > 1 && submitControl(o) === undefined;

const typing = (o: ScreenObservation, wanted: ReadonlyArray<readonly [FieldSource, ScreenControl | undefined]>): TypeAction => ({
  kind: "type",
  fields: wanted.flatMap(([source, target]) => (target ? [{ target, source }] : [])),
  submit: submitControl(o),
});

const skipOr = (o: ScreenObservation, noSkip: LoginOutcome, note: string): Action => {
  const target = choices(o, SKIP_NAME)[0];
  return target ? { kind: "skip", target, note } : stop(noSkip);
};

const factorPicker = (o: ScreenObservation, config: LoopConfig): Action => {
  if (!config.totpSeedConfigured) return stop("mfa-required-no-seed");
  const target = choices(o, AUTHENTICATOR_NAME)[0];
  return target ? { kind: "choose", target, note: "factor picker answered with the authenticator app" } : stop("mfa-enrollment-required");
};

const oneTimeCode = (o: ScreenObservation, config: LoopConfig): Action =>
  config.totpSeedConfigured ? typing(o, [["one-time-code", findCode(o)]]) : stop("mfa-required-no-seed");

const consent = (o: ScreenObservation): Action => {
  const target = choices(o, ACCEPT_NAME)[0];
  const fix =
    "A consent screen was accepted. Auth0 shows it for a third-party application: mark the application first-party in the " +
    "tenant (or skip user consent for its API) and the screen stops appearing.";
  return target ? { kind: "submit", target, note: fix } : stop("consent-required");
};

const stayNo = (o: ScreenObservation): Action => {
  const target = choices(o, NO_NAME)[0];
  return target ? { kind: "choose", target, note: "stay signed in answered No" } : stop("unknown-screen");
};

/** The picker is a list of organizations or a text box for one; either way the answer is the configured name. */
const organizationPicker = (o: ScreenObservation, config: LoopConfig): Action => {
  const wanted = config.organization?.trim().toLowerCase();
  if (!wanted) return stop("organization-required");
  const listed = o.controls.find((c) => CHOICE_ROLES.has(c.role) && c.name.trim().toLowerCase() === wanted);
  if (listed) return { kind: "choose", target: listed, note: `organization ${config.organization} chosen` };
  const box = o.controls.find((c) => INPUT_ROLES.has(c.role) && /organi[sz]ation/i.test(c.name));
  if (!box) return stop("organization-required");
  return { ...typing(o, [["organization", box]]), organization: config.organization };
};

type Decision = (observation: ScreenObservation, config: LoopConfig) => Action;

const landing = (o: ScreenObservation): Action => {
  const target = choices(o, LANDING_NAME)[0];
  return target ? { kind: "submit", target, note: "landing page's sign-in button pressed" } : stop("unknown-screen");
};

const FORM_DECISIONS: Record<FormScreen, Decision> = {
  "identifier-and-password": (o) => typing(o, [["identifier", findIdentifier(o)], ["password", findPassword(o)]]),
  identifier: (o) => typing(o, [["identifier", findIdentifier(o)]]),
  password: (o) => typing(o, [["password", findPassword(o)]]),
  "one-time-code": oneTimeCode,
  "factor-picker": factorPicker,
  "passkey-nudge": (o) => skipOr(o, "unknown-screen", "passkey prompt skipped"),
  "mfa-enrollment": (o) => skipOr(o, "mfa-enrollment-required", "authenticator enrolment offered and skipped"),
  "stay-signed-in": stayNo,
  consent,
  "organization-picker": organizationPicker,
  landing,
};

/** What to do on a recognised screen, as data. The one place a screen name becomes behaviour. */
export function nextAction(screen: Screen, config: LoopConfig, observation: ScreenObservation): Action {
  const decide = (FORM_DECISIONS as Partial<Record<Screen, Decision>>)[screen];
  return decide ? decide(observation, config) : stop(screen as EndingScreen);
}

/**
 * The flows step that would handle a screen nobody recognised, as text (design item 1, layer 3). Names only: the
 * values on the page are never echoed.
 */
export function unknownScreenStep(observation: ScreenObservation): string {
  const seen = [
    ...observation.headings.map((heading) => `heading "${heading}"`),
    ...observation.controls.map((control) => `${control.role} "${control.name}"`),
  ];
  const button = observation.controls.find((control) => control.role === "button");
  const heading = observation.headings[0];
  const example = button
    ? `- press: { control: "${button.name}" }`
    : heading
      ? `- expect: { heading: "${heading}" }`
      : "- expect: { control: <the control's accessible name> }";
  return `Screen not recognised (${seen.join(", ") || "nothing readable on it"}). Add a flows step that handles it, for example: ${example}`;
}

export interface Branch {
  readonly screen: Screen;
  readonly kind: Action["kind"];
  readonly note?: string;
  readonly outcome?: LoginOutcome;
}

export interface LoopResult {
  readonly outcome: "signed-in" | LoginOutcome;
  /** Every branch taken, in order: the run summary lists them. */
  readonly branches: readonly Branch[];
  readonly remedy?: string;
  /** Present on `unknown-screen`: the flows step that would handle it. */
  readonly flowsStep?: string;
}

export interface LoopOptions {
  readonly observe: () => Promise<ScreenObservation>;
  readonly act: (action: Action) => Promise<void>;
  readonly pause: (millis: number) => Promise<void>;
  readonly now: () => number;
  readonly budgetMillis: number;
  readonly config: LoopConfig;
}

/** Between two observations, so a page mid-navigation is polled rather than spun on. */
export const POLL_MILLIS = 500;

/** The same unrecognised page this many times running is not loading: end rather than spend the whole budget. */
export const UNKNOWN_SETTLE_OBSERVATIONS = 3;

interface LoopState {
  readonly branches: Branch[];
  lastActed: Screen | undefined;
  /** The last page that matched nothing or more than one screen, for the budget's ending. */
  unmatched: ScreenObservation | undefined;
  unmatchedKey: string;
  unmatchedStreak: number;
}

const keyOf = (o: ScreenObservation): string => JSON.stringify([o.headings, o.controls.map((c) => [c.role, c.name, c.autocomplete])]);

const unknownEnd = (o: ScreenObservation, branches: readonly Branch[]): LoopResult => ({
  outcome: "unknown-screen",
  branches,
  remedy: LOGIN_OUTCOMES["unknown-screen"].remedy,
  flowsStep: unknownScreenStep(o),
});

/** Settles the unmatched-page bookkeeping; returns a result when the same unrecognised page has stopped changing. */
function noteUnmatched(o: ScreenObservation, kind: "unknown-screen" | "ambiguous", state: LoopState): LoopResult | undefined {
  const key = keyOf(o);
  state.unmatchedStreak = key === state.unmatchedKey ? state.unmatchedStreak + 1 : 1;
  state.unmatchedKey = key;
  state.unmatched = o;
  const settled = kind === "unknown-screen" && state.unmatchedStreak >= UNKNOWN_SETTLE_OBSERVATIONS;
  return settled ? unknownEnd(o, state.branches) : undefined;
}

async function actOn(screen: Screen, o: ScreenObservation, options: LoopOptions, state: LoopState): Promise<LoopResult | undefined> {
  const action = nextAction(screen, options.config, o);
  if (action.kind === "stop") {
    state.branches.push({ screen, kind: "stop", outcome: action.outcome });
    return { outcome: action.outcome, branches: state.branches, remedy: action.remedy };
  }
  const note = "note" in action ? action.note : undefined;
  state.branches.push(note ? { screen, kind: action.kind, note } : { screen, kind: action.kind });
  await options.act(action);
  state.lastActed = screen;
  return undefined;
}

async function step(o: ScreenObservation, options: LoopOptions, state: LoopState): Promise<LoopResult | undefined> {
  const screen = classifyScreen(o);
  if (screen === "unknown-screen" || screen === "ambiguous") return noteUnmatched(o, screen, state);
  state.unmatched = undefined;
  state.unmatchedStreak = 0;
  state.unmatchedKey = "";
  if (screen === state.lastActed) return undefined;
  return actOn(screen, o, options, state);
}

/** The budget ran out: a page nobody could pick is `unknown-screen`; anything else never reached the check. */
function budgetEnd(state: LoopState): LoopResult {
  if (state.unmatched) return unknownEnd(state.unmatched, state.branches);
  const outcome: LoginOutcome = "signed-in-check-never-matched";
  return { outcome, branches: state.branches, remedy: LOGIN_OUTCOMES[outcome].remedy };
}

/**
 * Observe, classify, act; repeat until the signed-in check holds, an ending screen is reached or the budget is spent.
 * Ambiguous, unknown and unchanged pages are polled, never acted on.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const started = options.now();
  const state: LoopState = { branches: [], lastActed: undefined, unmatched: undefined, unmatchedKey: "", unmatchedStreak: 0 };
  const withinBudget = (): boolean => options.now() - started < options.budgetMillis;
  while (withinBudget()) {
    const observation = await options.observe();
    if (observation.signedIn) return { outcome: "signed-in", branches: state.branches };
    // An observation can itself take the rest of the budget; a screen read after the deadline is not acted on.
    if (!withinBudget()) break;
    const result = await step(observation, options, state);
    if (result) return result;
    await options.pause(POLL_MILLIS);
  }
  return budgetEnd(state);
}
