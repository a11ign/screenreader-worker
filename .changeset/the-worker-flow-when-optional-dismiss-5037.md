---
"@a11ign/screenreader-worker": minor
---

The worker's flow interpreter learns four step keys, with the same semantics and refusals as the CLI's (`packages/cli/src/auth/flows.ts`, `interpreter.ts`): `when: {kind, name}` runs a step only when that control is on the page, and skips it without failing when it is not; `optional: true` on a `fill`, `choose`, `check` or `press` waits the bind bound and skips the step only when no control of that name ever appeared, and still errors on an ambiguous match; `dismiss-if-shown: {control, within?, nth?}` presses a control when it is on the page and skips the step otherwise, reading the page once and never waiting. Every skip is recorded as an `authStepSkipped` mark carrying the phase, index, verb, name and reason.

`auto: true` is refused by name: it hands the screen to the CLI's built-in login loop, which the worker runs only for `auth.loginBlock`, so a flow cannot ask for it. `when:` is refused on `capture` and `dismiss-if-shown`, `optional:` on steps that cannot bind a control, and the login's last `expect:` may not carry `when:`, because that step always runs.
