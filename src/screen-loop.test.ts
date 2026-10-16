// THE WORKER'S SCREEN LOOP (a11ign#4998, part of #4084 v3 login phase 2). Every case is a plain observation and an injected clock: no browser,
// no network.
//
// The cases are the CLI's `packages/cli/src/auth/screen-loop.test.ts` (a11y-witness #4993) REPEATED AS LITERALS: two interpreters, one set
// of screens, and neither test imports the other. A loop that drifts from its specification turns one of these red from this side.
//
// POSITIVE CONTROL marks the cases that must act (the four-screen login, the skip, each recognised screen). NEGATIVE CONTROL marks the
// cases that must NOT act or must end: an ambiguous screen, an unmatched one, a blocked account, a bot challenge, a form that comes back
// unchanged, a loop that never matches. A suite of only the first could not tell a loop that works from one that acts on everything.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyScreen,
  LOGIN_OUTCOMES,
  nextAction,
  runLoop,
  UNKNOWN_SETTLE_OBSERVATIONS,
  type Action,
  type LoopConfig,
  type LoopResult,
  type ScreenControl,
  type ScreenObservation,
  type TypeAction,
} from "./screen-loop.ts";

const EMAIL: ScreenControl = { role: "textbox", name: "Email address", autocomplete: "username" };
const PASSWORD: ScreenControl = { role: "textbox", name: "Password", autocomplete: "current-password" };
const CODE: ScreenControl = { role: "textbox", name: "Enter the code", autocomplete: "one-time-code" };
const CONTINUE: ScreenControl = { role: "button", name: "Continue" };
const SIGN_IN_BUTTON: ScreenControl = { role: "button", name: "Log in" };

const screen = (headings: readonly string[], controls: readonly ScreenControl[]): ScreenObservation => ({ headings, controls, signedIn: false });
const SIGNED_IN: ScreenObservation = { headings: ["Dashboard"], controls: [], signedIn: true };

const IDENTIFIER = screen(["Welcome"], [EMAIL, CONTINUE]);
const PASSWORD_SCREEN = screen(["Enter your password"], [PASSWORD, CONTINUE]);
const COMBINED = screen(["Log in"], [EMAIL, PASSWORD, SIGN_IN_BUTTON]);
const OTP = screen(["Verify your identity"], [CODE, CONTINUE]);
const PASSKEY = screen(["Log in faster with a passkey"], [
  { role: "button", name: "Create a passkey" },
  { role: "button", name: "Continue without passkeys" },
]);
const BLOCKED = screen(["Account blocked"], [{ role: "alert", name: "Your account has been blocked." }]);
const BOT = screen(["One more step"], [{ role: "checkbox", name: "I'm not a robot" }]);
const LANDING = screen(["Sign in required"], [{ role: "button", name: "Sign in" }]);
const CONFIG: LoopConfig = { totpSeedConfigured: true };

interface Rig {
  readonly run: (script: ScreenObservation[], overrides?: Partial<{ budgetMillis: number; config: LoopConfig }>) => Promise<LoopResult>;
  readonly acted: Action[];
  readonly observed: () => number;
}

/** A scripted page: each observe reads the next entry and the last one repeats, as a page that stopped changing. */
const rig = (): Rig => {
  const acted: Action[] = [];
  let observations = 0;
  const run: Rig["run"] = (script, overrides = {}) => {
    let clock = 0;
    let index = 0;
    return runLoop({
      observe: async () => {
        observations += 1;
        const seen = script[Math.min(index, script.length - 1)];
        index += 1;
        return seen;
      },
      act: async (action) => {
        acted.push(action);
      },
      pause: async (millis) => {
        clock += millis;
      },
      now: () => clock,
      budgetMillis: overrides.budgetMillis ?? 60_000,
      config: overrides.config ?? CONFIG,
    });
  };
  return { run, acted, observed: () => observations };
};

describe("classifyScreen: recognised by accessible name and autocomplete token", () => {
  test("POSITIVE CONTROL: each login form is named from its controls and headings", () => {
    assert.equal(classifyScreen(IDENTIFIER), "identifier");
    assert.equal(classifyScreen(PASSWORD_SCREEN), "password");
    assert.equal(classifyScreen(COMBINED), "identifier-and-password");
    assert.equal(classifyScreen(OTP), "one-time-code");
    assert.equal(classifyScreen(PASSKEY), "passkey-nudge");
    assert.equal(classifyScreen(screen(["Stay signed in?"], [{ role: "button", name: "Yes" }, { role: "button", name: "No" }])), "stay-signed-in");
    assert.equal(classifyScreen(screen(["Authorize App"], [{ role: "button", name: "Accept" }, { role: "button", name: "Deny" }])), "consent");
    assert.equal(
      classifyScreen(screen(["Verify your identity"], [{ role: "button", name: "Google Authenticator" }, { role: "button", name: "SMS" }])),
      "factor-picker",
    );
  });

  test("the autocomplete token alone recognises a field whose label is unhelpful", () => {
    const odd = screen(["Hi"], [{ role: "textbox", name: "Field 1", autocomplete: "section-a one-time-code" }, CONTINUE]);
    assert.equal(classifyScreen(odd), "one-time-code");
  });

  test("the classification ignores CSS class names: a rebuilt stylesheet does not move a screen", () => {
    const rebuilt = screen(["Welcome"], [{ ...EMAIL, className: "c8f2a91" }, { ...CONTINUE, className: "_x_93kd" }]);
    assert.equal(classifyScreen(rebuilt), classifyScreen(IDENTIFIER));
    assert.equal(classifyScreen(rebuilt), "identifier");
  });

  test("NEGATIVE CONTROL: a control that only LOOKS right by its class name is not a login form", () => {
    const decoy = screen(["Welcome"], [{ role: "textbox", name: "", className: "username-input password-field" }]);
    assert.equal(classifyScreen(decoy), "unknown-screen");
  });

  test("NEGATIVE CONTROL: class names that say password and one-time-code on controls named otherwise do not make those screens", () => {
    const wearingClasses = screen(["Pick a nickname"], [
      { role: "textbox", name: "Nickname", className: "password-input one-time-code-field username" },
      { role: "button", name: "Save nickname", className: "login-button sign-in" },
    ]);
    assert.equal(classifyScreen(wearingClasses), "unknown-screen");
    const alertByClass = screen(["Welcome"], [EMAIL, CONTINUE, { role: "status", name: "Saved", className: "alert error invalid-code blocked" }]);
    assert.equal(classifyScreen(alertByClass), "identifier");
  });

  test("NEGATIVE CONTROL: a screen whose controls match two screens is ambiguous", () => {
    const both = screen(
      ["Stay signed in?", "Authorize App"],
      [{ role: "button", name: "Accept" }, { role: "button", name: "No" }],
    );
    assert.equal(classifyScreen(both), "ambiguous");
  });

  test("NEGATIVE CONTROL: an unmatched screen is unknown-screen", () => {
    assert.equal(classifyScreen(screen(["Pick a nickname"], [{ role: "textbox", name: "Nickname" }, CONTINUE])), "unknown-screen");
  });

  test("an alert on the one-time-code form ends it as rejected, not as the form again", () => {
    const rejected = screen(OTP.headings, [...OTP.controls, { role: "alert", name: "The code you entered is invalid" }]);
    assert.equal(classifyScreen(rejected), "totp-rejected");
    const wrongPassword = screen(COMBINED.headings, [...COMBINED.controls, { role: "alert", name: "Wrong email or password" }]);
    assert.equal(classifyScreen(wrongPassword), "credentials-rejected");
  });
});

describe("runLoop: act, observe, repeat, within one budget", () => {
  test("POSITIVE CONTROL: identifier, password, one-time code, signed in take three actions in order and list them", async () => {
    const r = rig();
    const result = await r.run([IDENTIFIER, PASSWORD_SCREEN, OTP, SIGNED_IN]);
    assert.equal(result.outcome, "signed-in");
    assert.deepEqual(result.branches.map((b) => b.screen), ["identifier", "password", "one-time-code"]);
    assert.deepEqual(r.acted.map((a) => (a.kind === "type" ? a.fields.map((f) => f.source).join("+") : a.kind)), [
      "identifier",
      "password",
      "one-time-code",
    ]);
  });

  test("POSITIVE CONTROL: a passkey nudge is skipped and the skip is recorded", async () => {
    const r = rig();
    const result = await r.run([COMBINED, PASSKEY, SIGNED_IN]);
    assert.equal(result.outcome, "signed-in");
    const skipped = result.branches.find((b) => b.screen === "passkey-nudge");
    assert.equal(skipped?.kind, "skip");
    assert.match(skipped?.note ?? "", /passkey/);
    const skip = r.acted.find((a) => a.kind === "skip");
    assert.equal(skip?.kind === "skip" && skip.target.name, "Continue without passkeys");
  });

  test("a combined login screen types both fields in one action, naming where each value comes from", async () => {
    const r = rig();
    await r.run([COMBINED, SIGNED_IN]);
    const typed = r.acted[0];
    assert.equal(typed.kind, "type");
    assert.deepEqual(typed.kind === "type" && typed.fields.map((f) => f.source), ["identifier", "password"]);
  });

  test("stay signed in is answered No, and a consent screen is accepted with the tenant fix in the summary", async () => {
    const r = rig();
    const stay = screen(["Stay signed in?"], [{ role: "button", name: "Yes" }, { role: "button", name: "No" }]);
    const consent = screen(["Authorize App"], [{ role: "button", name: "Accept" }, { role: "button", name: "Deny" }]);
    const result = await r.run([stay, consent, SIGNED_IN]);
    assert.equal(result.outcome, "signed-in");
    assert.equal(r.acted[0].kind === "choose" && r.acted[0].target.name, "No");
    assert.match(result.branches[1].note ?? "", /first-party/);
  });

  test("an organization picker is answered with the configured name, and ends organization-required without one", async () => {
    const picker = screen(["Select an organization"], [{ role: "button", name: "Acme" }, { role: "button", name: "Globex" }]);
    const withName = await rig().run([picker, SIGNED_IN], { config: { ...CONFIG, organization: "acme" } });
    assert.equal(withName.outcome, "signed-in");
    const r = rig();
    const without = await r.run([picker, SIGNED_IN]);
    assert.equal(without.outcome, "organization-required");
    assert.equal(r.acted.length, 0);
  });

  test("a factor picker chooses the authenticator app; with no seed it ends before choosing", async () => {
    const picker = screen(["Verify your identity"], [{ role: "button", name: "SMS" }, { role: "button", name: "Authenticator app" }]);
    const r = rig();
    await r.run([picker, SIGNED_IN]);
    assert.equal(r.acted[0].kind === "choose" && r.acted[0].target.name, "Authenticator app");
    const noSeed = rig();
    const ended = await noSeed.run([picker], { config: { totpSeedConfigured: false } });
    assert.equal(ended.outcome, "mfa-required-no-seed");
    assert.equal(noSeed.acted.length, 0);
  });

  test("a required enrolment with no way to skip it ends mfa-enrollment-required; an offered one is skipped", () => {
    const required = screen(["Secure your account"], [{ role: "button", name: "Set up authenticator" }]);
    assert.deepEqual(nextAction("mfa-enrollment", CONFIG, required).kind, "stop");
    const offered = screen(["Secure your account"], [{ role: "button", name: "Remind me later" }]);
    assert.equal(nextAction("mfa-enrollment", CONFIG, offered).kind, "skip");
  });

  test("NEGATIVE CONTROL: a one-time-code screen with no seed configured ends before typing a code", async () => {
    const r = rig();
    const result = await r.run([OTP, SIGNED_IN], { config: { totpSeedConfigured: false } });
    assert.equal(result.outcome, "mfa-required-no-seed");
    assert.equal(r.acted.length, 0);
  });
});

describe("runLoop: the landing screen, the app's own signed-out page", () => {
  test("POSITIVE CONTROL: a landing screen with one Sign in button presses it, and the login continues from there", async () => {
    assert.equal(classifyScreen(LANDING), "landing");
    const r = rig();
    const result = await r.run([LANDING, IDENTIFIER, SIGNED_IN]);
    assert.equal(result.outcome, "signed-in");
    assert.equal(r.acted[0].kind === "submit" && r.acted[0].target.name, "Sign in");
    assert.deepEqual(result.branches.map((b) => b.screen), ["landing", "identifier"]);
  });

  test("NEGATIVE CONTROL: a landing screen with TWO sign-in controls is not pressed, since which one starts the login is a guess", async () => {
    const twins = screen(["Sign in required"], [{ role: "button", name: "Sign in" }, { role: "button", name: "Log in" }]);
    const r = rig();
    const result = await r.run([twins], { budgetMillis: 5_000 });
    assert.equal(r.acted.length, 0, "two sign-in controls must never be pressed");
    assert.equal(result.outcome, "unknown-screen");
  });

  test("NEGATIVE CONTROL: a landing screen that comes back unchanged is pressed once, never again", async () => {
    const r = rig();
    const result = await r.run([LANDING], { budgetMillis: 5_000 });
    assert.equal(r.acted.length, 1, "the same landing is never pressed twice in a row");
    assert.equal(result.outcome, "signed-in-check-never-matched");
  });

  // a11ign#5534: the app's callback page returns after the provider's forms, and it is classified `landing` while the token exchange is in
  // flight. Pressing it there starts a second login on top of the first, so the landing is pressed once per loop, never after another screen.
  test("POSITIVE CONTROL (a11ign#5534): a landing that returns after the login's forms is waited on, and Sign in is pressed once", async () => {
    const r = rig();
    const result = await r.run([LANDING, COMBINED, OTP, LANDING, LANDING, SIGNED_IN]);
    assert.equal(result.outcome, "signed-in");
    assert.equal(r.acted.filter((a) => a.kind === "submit").length, 1, "Sign in is pressed once per login");
    assert.deepEqual(result.branches.map((b) => b.screen), ["landing", "identifier-and-password", "one-time-code"]);
  });

  test("NEGATIVE CONTROL (a11ign#5534): a landing that returns last is waited on, so the run ends with its one press and no second", async () => {
    const r = rig();
    const result = await r.run([LANDING, COMBINED, OTP, LANDING], { budgetMillis: 5_000 });
    assert.equal(r.acted.filter((a) => a.kind === "submit").length, 1, "a returning landing is never pressed");
    assert.equal(result.outcome, "signed-in-check-never-matched");
  });
});

describe("runLoop: the screens it must not act on, and the ends it must not retry", () => {
  test("NEGATIVE CONTROL: an ambiguous screen is not acted on, and is acted on once it resolves", async () => {
    const both = screen(["Stay signed in?", "Authorize App"], [{ role: "button", name: "Accept" }, { role: "button", name: "No" }]);
    const r = rig();
    const stuck = await r.run([both], { budgetMillis: 5_000 });
    assert.equal(r.acted.length, 0, "an ambiguous screen must never be acted on");
    assert.equal(stuck.outcome, "unknown-screen");
    const settling = rig();
    const resolved = await settling.run([both, IDENTIFIER, SIGNED_IN]);
    assert.equal(resolved.outcome, "signed-in");
    assert.deepEqual(resolved.branches.map((b) => b.screen), ["identifier"]);
  });

  test("NEGATIVE CONTROL: an unmatched screen ends unknown-screen with the step text, and is never acted on", async () => {
    const r = rig();
    const odd = screen(["Pick a nickname"], [{ role: "textbox", name: "Nickname" }, { role: "button", name: "Save nickname" }]);
    const result = await r.run([odd]);
    assert.equal(result.outcome, "unknown-screen");
    assert.equal(r.acted.length, 0);
    assert.match(result.flowsStep ?? "", /press: \{ control: "Save nickname" \}/);
    assert.match(result.flowsStep ?? "", /flows step/);
    assert.equal(r.observed(), UNKNOWN_SETTLE_OBSERVATIONS, "ends once the page stops changing, not at the budget");
  });

  test("NEGATIVE CONTROL: a blocked-account screen ends at once, never acted on and never retried", async () => {
    const r = rig();
    const result = await r.run([BLOCKED, IDENTIFIER, SIGNED_IN]);
    assert.equal(result.outcome, "account-blocked");
    assert.equal(r.acted.length, 0);
    assert.equal(r.observed(), 1);
  });

  test("NEGATIVE CONTROL: a bot-challenge screen ends at once, never acted on and never retried", async () => {
    const r = rig();
    const result = await r.run([BOT, IDENTIFIER, SIGNED_IN]);
    assert.equal(result.outcome, "bot-challenge");
    assert.equal(r.acted.length, 0);
    assert.equal(r.observed(), 1);
  });

  test("NEGATIVE CONTROL: wrong credentials end the login after one attempt, with the password typed once", async () => {
    const rejected = screen(COMBINED.headings, [...COMBINED.controls, { role: "alert", name: "Wrong email or password" }]);
    const r = rig();
    const result = await r.run([COMBINED, rejected, COMBINED]);
    assert.equal(result.outcome, "credentials-rejected");
    assert.equal(r.acted.length, 1);
  });

  test("NEGATIVE CONTROL: a form that comes back unchanged is waited on, never typed into twice, and stops at the budget", async () => {
    const r = rig();
    const result = await r.run([PASSWORD_SCREEN], { budgetMillis: 5_000 });
    assert.equal(r.acted.length, 1, "the same screen is never acted on twice in a row");
    assert.equal(result.outcome, "signed-in-check-never-matched");
  });

  test("NEGATIVE CONTROL: a rate-limit screen ends at once and a rejected one-time code is not typed again", async () => {
    const limited = screen(["Slow down"], [{ role: "alert", name: "Too many attempts. Try again later." }]);
    const r = rig();
    const ended = await r.run([limited, IDENTIFIER]);
    assert.equal(ended.outcome, "rate-limited");
    assert.equal(r.acted.length, 0);
    const rejected = screen(OTP.headings, [...OTP.controls, { role: "alert", name: "The code you entered is invalid" }]);
    const again = rig();
    const codeEnded = await again.run([OTP, rejected, OTP]);
    assert.equal(codeEnded.outcome, "totp-rejected");
    assert.equal(again.acted.length, 1, "the code is typed once; a rejection is final");
  });
});

describe("runLoop: the budget is enforced around observation too", () => {
  test("NEGATIVE CONTROL: an observation that spends the budget is not acted on", async () => {
    let clock = 0;
    const acted: Action[] = [];
    const result = await runLoop({
      observe: async () => {
        clock = 5_000;
        return IDENTIFIER;
      },
      act: async (action) => {
        acted.push(action);
      },
      pause: async () => {},
      now: () => clock,
      budgetMillis: 1_000,
      config: CONFIG,
    });
    assert.equal(acted.length, 0, "the deadline passed during observe, so nothing may be typed");
    assert.equal(result.outcome, "signed-in-check-never-matched");
  });

  test("a spent budget ends the loop without a further observation", async () => {
    const r = rig();
    const result = await r.run([IDENTIFIER], { budgetMillis: 0 });
    assert.equal(r.observed(), 0);
    assert.equal(result.outcome, "signed-in-check-never-matched");
  });

  test("NEGATIVE CONTROL: a loop that never matches anything stops at the budget and acts on nothing", async () => {
    const r = rig();
    const result = await r.run([screen(["Loading"], [])], { budgetMillis: 60_000 });
    assert.equal(result.outcome, "unknown-screen");
    assert.equal(r.acted.length, 0);
  });
});

describe("the sentences a person reads, as literals (the CLI's `login-outcomes.ts`, word for word)", () => {
  const REMEDIES: Record<string, string> = {
    "credentials-rejected": "The username or password was refused: check the values the run reads from the environment, and do not retry.",
    "account-blocked": "The provider has blocked this account: unblock it there, or sign in with another account.",
    "mfa-required-no-seed": "The login asks for a one-time code and no authenticator seed is configured: set the seed the run reads, or sign in from a saved state.",
    "totp-rejected": "The one-time code was refused: check the seed matches the authenticator app and the clock is in step, and do not retry.",
    "mfa-enrollment-required": "The account must enrol an authenticator app before it can sign in: enrol one with the provider, then run again.",
    "bot-challenge": "The provider showed a bot check the run will not answer: sign in from a saved state (--auth-state) taken where the check does not appear.",
    "rate-limited": "The provider is rate-limiting sign-in: wait before running again, since a retry now only adds to the limit.",
    "consent-required": "The site asks for consent the run will not give: grant it in a saved state (--auth-state) and run again.",
    "organization-required": "The provider asks which organization to sign in to, and the run did not name one: name it in the flow, then run again.",
    "unknown-screen": "The login reached a screen the run does not recognise: open that page in a browser and make the flow's expect step match it.",
    "signed-in-check-never-matched": "The signed-in check never matched after the login: check the flow's signed-in selector against the page the login reaches.",
  };

  test("POSITIVE CONTROL: every outcome the loop can reach carries the CLI's sentence", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(LOGIN_OUTCOMES).map(([outcome, { remedy }]) => [outcome, remedy])),
      REMEDIES,
    );
  });

  test("an ending carries its sentence on the result, so the caller says what the CLI would", async () => {
    const r = rig();
    const result = await r.run([BLOCKED]);
    assert.equal(result.remedy, REMEDIES["account-blocked"]);
    const unknown = await rig().run([screen(["Pick a nickname"], [{ role: "textbox", name: "Nickname" }])]);
    assert.equal(unknown.remedy, REMEDIES["unknown-screen"]);
  });
});

describe("the submit a typed form presses: a provider's button is never it, and two candidates are never picked by order", () => {
  const GOOGLE: ScreenControl = { role: "button", name: "Continue with Google" };
  const VERIFY: ScreenControl = { role: "button", name: "Verify" };
  const NEXT: ScreenControl = { role: "button", name: "Next" };

  /** The first action on an identifier page with these buttons beside the email field, when it is typed. */
  const typedFirst = async (buttons: readonly ScreenControl[]): Promise<TypeAction | undefined> => {
    const r = rig();
    await r.run([screen(["Welcome"], [EMAIL, ...buttons]), SIGNED_IN]);
    const first = r.acted[0];
    return first?.kind === "type" ? first : undefined;
  };

  test("POSITIVE CONTROL: the plain Continue is pressed beside a provider's button, whichever comes first on the page", async () => {
    assert.equal((await typedFirst([GOOGLE, CONTINUE]))?.submit?.name, "Continue");
    assert.equal((await typedFirst([CONTINUE, GOOGLE]))?.submit?.name, "Continue");
  });

  test("POSITIVE CONTROL: every provider the row names is never the submit, even when it is the only button", async () => {
    for (const name of ["Continue with Google", "Sign in with Apple", "Continue using GitHub", "Continue with Microsoft", "Continue with Facebook"]) {
      const alone = await typedFirst([{ role: "button", name }]);
      assert.ok(alone, `${name}: the identifier must still be typed`);
      assert.equal(alone.submit, undefined, name);
    }
  });

  test("the exact name wins over a looser one, whichever comes first", async () => {
    assert.equal((await typedFirst([VERIFY, SIGN_IN_BUTTON]))?.submit?.name, "Log in");
    assert.equal((await typedFirst([SIGN_IN_BUTTON, VERIFY]))?.submit?.name, "Log in");
  });

  test("NEGATIVE CONTROL: a provider's button alone is no submit, so the field is typed and Enter presses it", async () => {
    const typed = await typedFirst([GOOGLE]);
    assert.ok(typed, "the identifier must still be typed");
    assert.equal(typed.submit, undefined);
  });

  test("NEGATIVE CONTROL: a page whose only sign-in control is a provider's is unknown-screen, not a form", () => {
    assert.equal(classifyScreen(screen(["Welcome"], [GOOGLE])), "unknown-screen");
  });

  test("NEGATIVE CONTROL: two submits with no exact name are ambiguous, and nothing is typed or pressed", async () => {
    const both = screen(["Welcome"], [EMAIL, NEXT, VERIFY]);
    assert.equal(classifyScreen(both), "ambiguous");
    const r = rig();
    const result = await r.run([both]);
    assert.equal(r.acted.length, 0, "an ambiguous submit must never be guessed at");
    assert.equal(result.outcome, "unknown-screen");
  });
});

describe("the branch records the alerts and controls the screen showed (#5673)", () => {
  const CODE_REJECTED = "The code you entered is invalid";

  test("POSITIVE CONTROL: a one-time-code screen with an alert ends on a stop branch that carries the alert", async () => {
    const rejected = screen(OTP.headings, [...OTP.controls, { role: "alert", name: CODE_REJECTED }]);
    const r = rig();
    const result = await r.run([rejected]);
    const stop = result.branches.at(-1);
    assert.equal(stop?.kind, "stop");
    assert.equal(stop?.outcome, "totp-rejected");
    assert.deepEqual(stop?.alerts, [{ role: "alert", name: CODE_REJECTED }]);
  });

  test("POSITIVE CONTROL: the stop branch carries every control the screen showed, as role and name only", async () => {
    const rejected = screen(OTP.headings, [...OTP.controls, { role: "alert", name: CODE_REJECTED }]);
    const r = rig();
    const result = await r.run([rejected]);
    assert.deepEqual(result.branches.at(-1)?.controls, [
      { role: "textbox", name: "Enter the code" },
      { role: "button", name: "Continue" },
      { role: "alert", name: CODE_REJECTED },
    ]);
  });

  test("NEGATIVE CONTROL: a screen with no alert records alerts as an empty list, not an absent field", async () => {
    const r = rig();
    const result = await r.run([IDENTIFIER, SIGNED_IN]);
    assert.deepEqual(result.branches[0].alerts, []);
    assert.equal(result.branches[0].kind, "type");
  });

  test("NEGATIVE CONTROL: a control's class name and autocomplete token are never copied into the branch", async () => {
    const withClass = screen(IDENTIFIER.headings, [{ ...EMAIL, className: "c-provider-rebuilt" }, CONTINUE]);
    const r = rig();
    const result = await r.run([withClass, SIGNED_IN]);
    assert.deepEqual(result.branches[0].controls, [
      { role: "textbox", name: "Email address" },
      { role: "button", name: "Continue" },
    ]);
  });

  test("NEGATIVE CONTROL: a value typed into a field is in no branch, while the typing itself did happen", async () => {
    const secret = "correct-horse-battery";
    const typed: string[] = [];
    let observations = 0;
    const script = [PASSWORD_SCREEN, SIGNED_IN];
    const result = await runLoop({
      observe: async () => script[Math.min(observations++, script.length - 1)],
      act: async () => {
        typed.push(secret);
      },
      pause: async () => {},
      now: () => 0,
      budgetMillis: 60_000,
      config: CONFIG,
    });
    assert.equal(result.outcome, "signed-in");
    assert.equal(typed.length, 1, "the typing reached the act step");
    assert.equal(JSON.stringify(result.branches).includes(secret), false);
  });
});
