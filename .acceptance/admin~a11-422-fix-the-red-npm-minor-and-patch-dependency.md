# A11-422: the npm-minor-and-patch group compiles against @a11ign/evidence 0.5.0

Takes the Dependabot group bump (a11ign/screenreader-worker#94) and points the eight test files that imported
`stripComments` from the removed `@a11ign/evidence/source-text` subpath at `@a11ign/toolchain/lib/source-text`,
which `@a11ign/toolchain` 0.15.0 exports with the same signature. Test files and comments only; no runtime code changes.

Acceptance:

```bash
set -e
pnpm install --frozen-lockfile
# no file in src/ imports the removed subpath
! git grep -n "@a11ign/evidence/source-text" -- src
# every importer of stripComments takes it from the toolchain
[ "$(git grep -l "import { stripComments }" -- src | wc -l)" = "$(git grep -l 'import { stripComments } from "@a11ign/toolchain/lib/source-text"' -- src | wc -l)" ]
# the rest of the gate's checks job, in its order
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm test
```
