---
"@a11ign/screenreader-worker": minor
---

The package publishes a Windows launcher, `launcher/run-server.cmd`, and the foreground-lock script it runs beside itself, `launcher/apply-foreground-lock-timeout.ps1`. The launcher resolves its own location inside `node_modules/@a11ign/screenreader-worker/`, starts `dist/server.mjs`, and takes the host's working directory from argument 2 or `A11Y_WORKER_DIR` (refusing to start when neither is set) instead of assuming the package sits three levels under a checkout root. The checkout's `src/run-server.cmd` is unchanged for now (ADR 0045, cut 5 of 9).
