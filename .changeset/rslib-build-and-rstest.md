---
"@a11ign/screenreader-worker": minor
---

The package is built. `exports` points at `dist/*.mjs` with a `.d.mts` beside each, `files` ships `dist`, and `bin` is `dist/server.mjs`, where 0.1.0 shipped the raw `src/*.mjs` with no declarations. The specifiers are unchanged. The worker's own `src` is untouched and is still what the fleet deploys (ADR 0031): `codeVersion()` and `WORKER_FILES` keep hashing source files, so `codeVersion()` with no argument, from the installed package, now looks in `dist` and throws; pass the source directory, as the fleet does.
