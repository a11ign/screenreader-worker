---
"@a11ign/screenreader-worker": patch
---

The `sweep` diagnostic mark now splits each direction's round-trip time into `tripPerformMs` (the NVDA keystroke), `tripLogMs` (the speech-log reads) and `tripQuietMs` (the silence waits), under `prevSplit` and `nextSplit`. The evidence a capture records is unchanged; the mark only gains fields.
