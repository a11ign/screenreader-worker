# @a11ign/screenreader-worker

## 0.2.0

### Minor Changes

- 4d04c5c: The package is built. `exports` points at `dist/*.mjs` with a `.d.mts` beside each, `files` ships `dist`, and `bin` is `dist/server.mjs`, where 0.1.0 shipped the raw `src/*.mjs` with no declarations. The specifiers are unchanged. The worker's own `src` is untouched and is still what the fleet deploys (ADR 0031): `codeVersion()` and `WORKER_FILES` keep hashing source files, so `codeVersion()` with no argument, from the installed package, now looks in `dist` and throws; pass the source directory, as the fleet does.

## 0.1.0

### Minor Changes

- da71e44: The first release from this repository: the worker's source and its history (392 commits, moved out of `a11ign/a11ign` with `git filter-repo`), published by npm trusted publishing over OIDC with provenance and no stored token.
