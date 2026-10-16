// Was this module the process entry point, or was it imported by one?
//
// Node resolves the main module's real path for `import.meta.url`, but leaves `process.argv[1]` as it was
// typed. A launcher that reaches the server through a symlink or a junction (a pnpm link, or a Windows junction
// in node_modules) therefore compared a real path with a link path, found them unequal, treated the server as a
// library, and exited 0 with no output: worker-5 went down on that shape. Both sides are resolved here, so the
// answer is the same whichever way the path was spelled.
//
// A path that does not resolve is not an entry point. It is answered false rather than thrown, because a
// missing argv[1] is what a REPL or an `-e` import looks like, and throwing there would make importing the
// module a crash instead of a library load.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export function isEntryPoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    const entry = realpathSync(argv1);
    const self = realpathSync(fileURLToPath(metaUrl));
    return pathToFileURL(entry).href === pathToFileURL(self).href;
  } catch {
    return false;
  }
}
