---
"@a11ign/screenreader-worker": patch
---

The `left-origin` sentence no longer calls an identity-provider redirect SSO "which v1 does not do". It now says that a redirect to an identity provider the flow does not declare ends the run, and names the `idp-origins:` declaration that allows it; SSO beyond that is still not supported. The CLI prints the same sentence, and the two are held to one literal by a parity test.
