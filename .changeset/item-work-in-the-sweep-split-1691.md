---
"@a11ign/screenreader-worker": patch
---

The `sweep` diagnostic mark now splits each direction's time into four buckets: `tripItemMs` is the `onItem` work between round trips, which the three trip buckets never covered, so the four add up to the direction's time. The trip buckets are measured with `performance.now()`, so a sub-millisecond round is no longer read as zero. The evidence a capture records is unchanged; the mark only gains a field and its numbers are fractional milliseconds.
