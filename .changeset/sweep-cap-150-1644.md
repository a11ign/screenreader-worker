---
"@a11ign/screenreader-worker": patch
---

The per-direction cap on a quick-nav sweep is lowered from 250 steps to 150. On a page that runs to the cap, a sweep now stops after 150 steps where it used to stop after 250, so a form whose fields lie past step 150 is read less and is recorded as incomplete. Ordinary pages are not affected. The cost of the lower cap as evidence is not yet measured.
