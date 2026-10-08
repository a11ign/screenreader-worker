---
"@a11ign/screenreader-worker": minor
---

`node capture.mjs <url> <outFile> [steps] --auth <plan.json>` runs an authenticated capture on the worker's own machine and prints the heading NVDA announced after the login. The plan is the wire `auth` object a capture request carries, validated by the worker's own validator; its `fromEnv` credentials are read from that process's environment, and a variable that is unset or empty stops the run with a sentence naming it before anything is launched. It also prints whether `A11Y_DIAG_SKIP_LOGIN_MARK` is set in that process, so a transcript says which of the two runs it is.

Nothing in the request protocol, the server or the CLI changes, and no remote path is opened: the CLI still refuses a remote `--worker` for an auth request and the server still answers `403` to a non-loopback peer. The credentials must be fakes belonging to no account, since the transcript is written to the output file. Without `--auth`, `capture.mjs` is exactly what it was.
