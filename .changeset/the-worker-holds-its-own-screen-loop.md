---
"@a11ign/screenreader-worker": minor
---

The worker holds its own copy of the login screen loop and runs it for a request carrying `auth.loginBlock` (`url`, `usernameEnv`, `passwordEnv`, `totpEnv`, `check`, optional `organization`): `src/screen-loop.ts` is a pure copy of the CLI's, `src/auth-flow.ts` drives it over CDP. A screen is classified by accessible name and `autocomplete` token, never by CSS; the loop acts only when exactly one screen matches, never re-acts on a screen it already acted on, and stops at once on a bot check, an account lock or a wrong password.

The wire carries variable NAMES only and is validated again on arrival: a value where a name belongs is refused naming the key, never echoing the value; `loginBlock` with `login` or `state`, an unknown key, or a `url` off the app origin is refused. A secret the environment holds malformed is refused before launch; an unset authenticator secret ends the loop `mfa-required-no-seed` rather than guessing. The app origin and `idpOrigins` are asserted before every observation and every fill, and a TOTP code is generated immediately before it is typed and never reused within a window.

`screen-loop.ts`, `totp.ts` and `otpauth.ts` join `WORKER_FILES`, so **`/health.code` changes for every worker** and the fleet reads every worker as stale until it is redeployed.
