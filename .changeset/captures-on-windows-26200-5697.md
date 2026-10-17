---
"@a11ign/screenreader-worker": patch
---

A capture no longer takes Chrome DevTools `Page.bringToFront` as proof that the browser is in front. On Windows 11 build 26200 that request resolved while the foreground stayed on the launcher's `cmd.exe`, NVDA started there, and the capture read `["blank","blank"]`. The foreground handle read back from the operating system now decides; a refused request is retried with a synthetic Alt press and then an attached input queue, and the winning method is reported. Where the operating-system check cannot run at all, the earlier behaviour stands.
