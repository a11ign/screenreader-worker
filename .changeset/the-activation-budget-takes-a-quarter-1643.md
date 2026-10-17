---
"@a11ign/screenreader-worker": patch
---

The per-field activation under probe-forms takes a quarter of the time left when its sweep begins, not a half (a11ign/agent-org#1643). On a runner's `survey.html` the activation spent 98.2 s of the 187.6 s that half allowed; a quarter binds there. The recapture reads the time and how many fields went unactivated.
