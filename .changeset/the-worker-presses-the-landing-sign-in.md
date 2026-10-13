---
"@a11ign/screenreader-worker": patch
---

The worker's screen loop presses the app's own sign-in button on a signed-out page that asks for nothing: no field, and exactly one control named "Sign in" or "Log in". Before this, a login that started on such a page (the Auth0 test app's "Sign in required") ended `unknown-screen` before it reached the identity provider. The CLI's loop learned this in a11ign/a11ign#5289 (#5278), and this ports it to the worker's copy, which is the loop that runs a capture's login. A page with two such controls is still not pressed, and a landing page that comes back unchanged is pressed once and never again.
