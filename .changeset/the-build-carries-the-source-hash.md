---
"@a11ign/screenreader-worker": minor
---

`codeVersion()` with no argument works from the built package. It returns the hash of the `src` the package was built from, written into `dist/code-version.mjs` by `scripts/write-code-version.ts` after `rslib build`, where it threw ENOENT because the built `workerSourceDir()` is `dist/`. `codeVersion(dir)` is unchanged, and so are `src/code-version.ts`, `WORKER_FILES` and every worker's `/health.code` (`912bd620a9960d40`). `workerSourceDir()` still names `dist/`, which is not the source a guest runs, so a consumer that wants the expected hash calls `codeVersion()` and no longer passes it.
