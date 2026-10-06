import { readFileSync } from "node:fs";
import { defineConfig } from "@rslib/core";
import { libraryPreset } from "@a11ign/toolchain/rslib-presets";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const [library] = libraryPreset(pkg, { dir: import.meta.dirname }).lib;

// `url: false` leaves `new URL("./", import.meta.url)` as written. Rspack otherwise reads that shape as an asset, copies the file it
// names into `dist/static/assets/` and rewrites the call: `workerSourceDir()` in `code-version.mjs` came out as a path to
// `static/assets/index.mjs`, a FILE, where the source reads "this module's own directory". That file is in `WORKER_FILES` and is
// hashed into `/health.code`, so the fix is made here and not by editing it, which would move the fleet's code hash.
//
// `server` is built beside the `exports` entries because `bin` names it and is not an `exports` key, so the preset cannot see it. It
// spawns `./windows-trim.mjs` as a sibling, and that one is an `exports` entry, so it lands next to it in `dist`.
export default defineConfig({
  lib: [{ ...library, source: { entry: { ...library.source.entry, server: "./src/server.mjs" } } }],
  // `chunkIds: "named"` keeps the chunk the entries share (`server` and the exports use the same modules) readable in `dist`, where
  // the default writes `e.mjs`, `v.mjs` and `x.mjs`.
  tools: {
    rspack: {
      module: { rules: [{ test: /\.mjs$/, parser: { url: false } }] },
      optimization: { chunkIds: "named" },
    },
  },
});
