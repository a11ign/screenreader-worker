---
"@a11ign/screenreader-worker": patch
---

A capture whose screen reader spoke a shell window rather than the page is now a retryable fault, not a success. A `cmd.exe` console read as two identical phrases on Windows 11 build 26200, and the taskbar read as one phrase on 22631, both came back as `["blank","blank"]` or `["Taskbar"]` and were returned as a capture. The worker now cold-starts the screen reader and captures again with the browser in front.
