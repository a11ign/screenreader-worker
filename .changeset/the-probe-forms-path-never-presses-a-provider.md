---
"@a11ign/screenreader-worker": patch
---

The probe-forms path never presses a control that names an identity provider. `Continue with Google`, `Sign in with Apple`, and the Microsoft, GitHub and Facebook forms were classified as a submit by `probeKindFor` and pressed whenever probe-forms was on, which takes the page to the provider's own login. Now such a control is no probe at all, as a submit, a task or a disclosure, and the plain `Continue` or `Sign in` beside it is still the submit. The provider list is one module, `identity-provider.ts`, that the screen loop and the probe both read, so a provider added to one cannot be missing from the other. This is the probe path's counterpart to the screen loop's fix (a11ign#5494).
