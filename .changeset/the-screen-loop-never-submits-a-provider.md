---
"@a11ign/screenreader-worker": patch
---

The login's screen loop never presses a provider-named control as a typed form's submit. `Continue with Google` (and `Sign in with Apple`, Microsoft, GitHub, Facebook) was taken by page order, so a tenant that shows it beside the plain `Continue` could have the provider's button pressed. Now a provider's control is never the submit; among several candidates the exact name (`Continue`, `Log in`) wins; and when several share no exact name the typing form is `ambiguous`, so the loop waits instead of guessing. This is the worker's copy of the fix the CLI already carries (a11ign#5493).
