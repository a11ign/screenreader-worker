# @a11ign/screenreader-worker

## 0.8.0

### Minor Changes

- 847b9da: The form-control census reports `form` (the index of the owning form in `document.forms`, absent when there is none) and `required` (the attribute, not `aria-required`) on each control, and `populatedFromEarlier` on an email field with an earlier email in the same form: a sentinel is written to the earlier field through the native value setter, `input` and `change` are dispatched, and the answer is whether the later field's value changed to non-empty. Both fields are restored. This is the first census key that writes to the page's fields; it presses no button. Other controls carry no `populatedFromEarlier` key.
  
  `CAPTURE_PROTOCOL_VERSION` moves from 23 to 24, because the capture cache would otherwise keep serving captures that lack the fields. Captures cached at 23 are not reused.

## 0.7.0

### Minor Changes

- e03419a: The worker is TypeScript. Its 37 `.mjs` (`src/`, the config and smoke files at the root, `scripts/write-code-version`) are `.ts`, converted by `@a11ign/toolchain`'s `js-to-ts`, and `mjs-ratchet.baseline.json` is EMPTY: a new `.js`, `.mjs` or `.cjs` fails `pnpm test`.
  
  What a consumer sees: `exports.*.types` point at `dist/*.d.ts` where they pointed at `dist/*.d.mts` (Rslib names a declaration after its source, and the source is `.ts`); the `exports` and `bin` runtime targets are unchanged (`dist/*.mjs`). `WORKER_FILES` names `.ts` files, so **`/health.code` changes for every worker**, and a fleet that compares it reads every worker as stale until it is redeployed. A guest runs `src/server.ts` and `src/capture/nvda/capture.ts` (`run-server.cmd`, `run-capture.cmd`) under its pinned Node 24, which strips the types itself; `windows-trim` is spawned beside whichever extension the server was loaded as.
  
  `pnpm run build` runs its last step under `tsx` (a new dev dependency), as does `eslint.config.ts` under `jiti`: the Node 22 on this host is built without type stripping.

## 0.6.0

### Minor Changes

- 6cbf34a: The form-control census reports `pasteCancelled` on each password field: whether a cancelable `paste` event dispatched at it was cancelled, which reads the outcome of `onpaste="return false"` and of a `paste` listener alike. Other controls carry no such key.
  
  `CAPTURE_PROTOCOL_VERSION` moves from 22 to 23, because the capture cache would otherwise keep serving captures that lack the field. Captures cached at 22 are not reused.

## 0.5.2

### Patch Changes

- 4b8184d: The repository holds one package at its root: the private, never-published `nvda-speech` Python subtree moved from `packages/nvda-speech/` into `src/nvda-speech/` and `pnpm-workspace.yaml` is gone (a11ign/a11ign#4214). Nothing in the published tarball changes.

## 0.5.1

### Patch Changes

- 6975ae7: The repository counts its `.js`/`.mjs`/`.cjs` source files against a committed baseline (`mjs-ratchet.baseline.json`, 37 basenames, no exceptions), through `@a11ign/toolchain/mjs-ratchet` (pin 0.1.2 to 0.1.4). `src/mjs-ratchet.test.ts` is run by the existing `pnpm test`: a new such file fails and is named, a drop passes and says the baseline can be lowered. Development tooling only; nothing the package ships changes.

## 0.5.0

### Minor Changes

- d38780d: `node capture.mjs <url> <outFile> [steps] --auth <plan.json>` runs an authenticated capture on the worker's own machine and prints the heading NVDA announced after the login. The plan is the wire `auth` object a capture request carries, validated by the worker's own validator; its `fromEnv` credentials are read from that process's environment, and a variable that is unset or empty stops the run with a sentence naming it before anything is launched. It also prints whether `A11Y_DIAG_SKIP_LOGIN_MARK` is set in that process, so a transcript says which of the two runs it is.
  
  Nothing in the request protocol, the server or the CLI changes, and no remote path is opened: the CLI still refuses a remote `--worker` for an auth request and the server still answers `403` to a non-loopback peer. The credentials must be fakes belonging to no account, since the transcript is written to the output file. Without `--auth`, `capture.mjs` is exactly what it was.

## 0.4.0

### Minor Changes

- 3f0b64f: A login may now pass through an identity provider, and a diagnostic switch can show whether the mark after a login matters. Neither was in 0.3.0, so a worker built from it refuses a login that leaves the app's origin with `left-origin` before NVDA is started.
  
  - **`auth.idpOrigins` is a new optional request field**: a list of exact origins (scheme, host and port, no path, query, fragment or credential, and no wildcard) that the login steps, and only those, may navigate through. The list is normalised to `URL.origin` and de-duplicated. An entry that is not an origin, or is the app's own origin, is refused with `auth.idpOrigins entry <n> …` and never echoed back, since a request may have put a credential in it. Absent means none, and the plan keeps its old shape. An origin that is not listed still ends the capture `left-origin`, and so does any origin after the login, in the `flow` steps.
  - **The window is marked navigated after a login even when the requested page is not loaded again.** A login that ends on the requested page used to skip the reload, so the mark NVDA needs to re-read its buffer was never made. It is now made once the sign-in has finished.
  - **`A11Y_DIAG_SKIP_LOGIN_MARK=1` is a diagnostic-only switch** in the worker process's environment (not in a request): the login then does not mark the window, and the capture's record carries `loginMarkSuppressed`. Only the exact value `1` turns it on, and it is read at each capture; unset, empty, `0` or anything else changes nothing. No request field, CLI flag or Action input can set it. **A capture taken with it set is not a product reading.**

## 0.3.0

### Minor Changes

- e3cb5e1: `codeVersion()` with no argument works from the built package. It returns the hash of the `src` the package was built from, written into `dist/code-version.mjs` by `scripts/write-code-version.mjs` after `rslib build`, where it threw ENOENT because the built `workerSourceDir()` is `dist/`. `codeVersion(dir)` is unchanged, and so are `src/code-version.mjs`, `WORKER_FILES` and every worker's `/health.code` (`912bd620a9960d40`). `workerSourceDir()` still names `dist/`, which is not the source a guest runs, so a consumer that wants the expected hash calls `codeVersion()` and no longer passes it.

## 0.1.0

### Minor Changes

- da71e44: The first release from this repository: the worker's source and its history (392 commits, moved out of `a11ign/a11ign` with `git filter-repo`), published by npm trusted publishing over OIDC with provenance and no stored token.
