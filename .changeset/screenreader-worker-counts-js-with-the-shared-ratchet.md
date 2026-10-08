---
"@a11ign/screenreader-worker": patch
---

The repository counts its `.js`/`.mjs`/`.cjs` source files against a committed baseline (`mjs-ratchet.baseline.json`, 37 basenames, no exceptions), through `@a11ign/toolchain/mjs-ratchet` (pin 0.1.2 to 0.1.4). `src/mjs-ratchet.test.ts` is run by the existing `pnpm test`: a new such file fails and is named, a drop passes and says the baseline can be lowered. Development tooling only; nothing the package ships changes.
