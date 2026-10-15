Row #5494: the screen loop never presses a provider-named control as the form's submit, in the worker's own copy of `screen-loop.ts` (the sibling of a11ign#5493). A control whose name names an identity provider (`Continue with Google`, `Sign in with Apple`, `… with Microsoft`, `… with GitHub`, `… with Facebook`) is never a typed form's submit, and when several candidates share no exact name (`Continue`, `Log in`) the typing form is `ambiguous` instead of pressing the first by page order.

Acceptance: `grep -q "Continue with Google" src/screen-loop.test.ts && pnpm exec rstest run src/screen-loop.test.ts`

The row's own command names `~/repos/screenreader-worker`, the primary checkout, which has this change only after the merge is pulled; the command above is the same grep and test at this pull request's head.
