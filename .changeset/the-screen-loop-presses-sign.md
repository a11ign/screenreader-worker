---
"@a11ign/screenreader-worker": patch
---

The login's screen loop presses the app's `Sign in` once per login. The app's callback page comes back as the landing screen while its token exchange is still in flight, and the loop pressed `Sign in` again, starting a second login on top of the first. Now a landing is pressed once per loop: a landing that returns after another screen is waited on and never pressed. This is the worker's copy of the fix for a11ign#5534 in the CLI.
