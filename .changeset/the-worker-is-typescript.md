---
"@a11ign/screenreader-worker": minor
---

The worker is TypeScript. Its 37 `.mjs` (`src/`, the config and smoke files at the root, `scripts/write-code-version`) are `.ts`, converted by `@a11ign/toolchain`'s `js-to-ts`, and `mjs-ratchet.baseline.json` is EMPTY: a new `.js`, `.mjs` or `.cjs` fails `pnpm test`.

What a consumer sees: `exports.*.types` point at `dist/*.d.ts` where they pointed at `dist/*.d.mts` (Rslib names a declaration after its source, and the source is `.ts`); the `exports` and `bin` runtime targets are unchanged (`dist/*.mjs`). `WORKER_FILES` names `.ts` files, so **`/health.code` changes for every worker**, and a fleet that compares it reads every worker as stale until it is redeployed. A guest runs `src/server.ts` and `src/capture/nvda/capture.ts` (`run-server.cmd`, `run-capture.cmd`) under its pinned Node 24, which strips the types itself; `windows-trim` is spawned beside whichever extension the server was loaded as.

`pnpm run build` runs its last step under `tsx` (a new dev dependency), as does `eslint.config.ts` under `jiti`: the Node 22 on this host is built without type stripping.
