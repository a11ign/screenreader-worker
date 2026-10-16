---
"@a11ign/screenreader-worker": patch
---

Each branch the screen loop takes now records the alerts and controls the screen showed. `alerts` lists every `alert` control as its role and accessible name, and is `[]` when the screen had none, so "no alert" and "not recorded" are different readings. `controls` lists every control the same way, so a field error that is not an `alert` role is visible beside the alert. A branch that stops the loop carries both too. Only roles and names are recorded: a field's value and a control's class name never reach a branch.
