Adds the two gates that `a11ign/a11ign` ran on this code and the move (#2701) dropped.

- `eslint.config.mjs`: `max-lines-per-function` 70 (blank lines and comments skipped), `complexity` 15, `max-depth` 3, `max-params` 4, `no-empty` with `allowEmptyCatch: false`. These equal a11ign/a11ign's values. NOT carried over: its four `local/*` rules (they import that repo's guard modules and police trees that do not exist here, e.g. merge-queue rollup reads) and `no-magic-numbers` (a non-blocking warning there).
- `tsconfig.json` (noEmit, strict, allowJs) over `packages/*/src/**/*.ts` and `scripts/**/*.ts`, so the tests are checked and the `.mjs` they import come along.
- `lint` and `typecheck` scripts; `ci.yml`'s `gate` job runs both before `pnpm test`.
- `playwright` as a devDependency: `auth-flow-cdp.test.ts` dynamically imports it and `tsc` could not resolve it (it was an optionalDependency in a11ign/a11ign). Types only; no browser is downloaded, so the test's "no browser" path is unchanged.

Measured at this head: `pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck` exit 0; `pnpm test` 683 tests, 665 pass, 0 fail, 18 skipped.
Mutation: a scratch file breaking each of the five lint limits produced one error each (max-params, max-depth, complexity, max-lines-per-function, no-empty); a `const n: number = "x"` test file failed `tsc` with TS2322. Both scratch files removed.

Acceptance:
```bash
pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck
```

Closes: none -- this PR is in a11ign/screenreader-worker; a11ign/a11ign#3179 is closed by its completion comment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
