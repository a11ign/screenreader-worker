---
"@a11ign/screenreader-worker": patch
---

A capture whose screen reader spoke a window other than the page is now a retryable fault, not a success. The window's spoken title is compared with the page's own title; when it does not contain it, and the transcript is at most two identical phrases, the capture fails. A `cmd.exe` console read as two identical phrases on Windows 11 build 26200, and the taskbar read as one phrase on 22631, both came back as `["blank","blank"]` or `["Taskbar"]` and were returned as a capture. The worker now cold-starts the screen reader and captures again with the browser in front. When the page's title cannot be read, only shell windows are caught.
