---
"@a11ign/screenreader-worker": patch
---

The worker's server now starts when the launcher reaches it through a symlink or a directory junction. Before, it compared the real path of its own module with `process.argv[1]` as typed, found them unequal under a linked `node_modules` path, took itself for a library, and exited 0 with no output: worker-5 went down that way after a provision (a11ign#5155). Both sides are resolved to real paths before the comparison, and a path that does not resolve is not an entry point, so importing the module still stays silent. A run by a real path is unchanged.
