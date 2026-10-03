// @ts-check
// command: decide what a push to main means for the release (version-pr, publish or nothing)
// WHICH OF THREE THINGS A PUSH TO `main` MEANS, decided from the pushed tree and the registry and nothing else.
//
//   version-pr  a changeset naming a release is pending  -> `release.yml` opens or updates the ONE version pull request
//   publish     none is pending AND a package's version is STRICTLY NEWER than the registry's latest -> the push the
//               version pull request's merge made
//   nothing     neither
//
// THE REGISTRY IS THE STATE, NOT A FLAG: a publish that failed is re-run and reads the same answer, and a package the
// registry already has is never in `publish`.
//
// `0.0.0` IS A PLACEHOLDER AND IS NEVER PUBLISHABLE. A package the registry has never heard of (E404), or holds only
// as the reservation `0.0.0-reserved.0`, counts as latest `0.0.0`, so a manifest that still says `0.0.0` is not ahead
// of it and `changeset publish`, which sends any version the registry lacks, is never reached with it.
//
// "COULD NOT ASK" IS NOT "NOT PUBLISHED": any registry failure but a 404 throws, because the reading that follows from
// the wrong one is a publish.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_BUMP = /:\s*(major|minor|patch)\s*$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The numeric core of a version, prerelease tag dropped: `0.0.0-reserved.0` reads as `0.0.0`.
 * @param {string} version @returns {[number, number, number]}
 */
export function core(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`${version} is not an x.y.z version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {string} local @param {string} registry */
export function isAhead(local, registry) {
  if (!/^\d+\.\d+\.\d+$/.test(local)) throw new Error(`${local} is not a plain x.y.z version`);
  const [a, b] = [core(local), core(registry)];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * The frontmatter of a changeset names a release when one line is `"pkg": major|minor|patch`. The empty changeset a
 * tool may leave names none, and counting it would ask for a version pull request for ever.
 * @param {string} text
 */
export function namesARelease(text) {
  const lines = text.split("\n");
  const fences = lines.flatMap((line, i) => (/^---\s*$/.test(line) ? [i] : []));
  if (fences.length < 2) return false;
  return lines.slice(fences[0] + 1, fences[1]).some((line) => RELEASE_BUMP.test(line));
}

/** @param {string} dir */
export function pendingChangesets(dir = ".changeset") {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .filter((file) => namesARelease(readFileSync(join(dir, file), "utf8"))).length;
}

/** @param {{ pending: number, ahead: number }} facts @returns {"version-pr" | "publish" | "nothing"} */
export function decideMode({ pending, ahead }) {
  if (pending > 0) return "version-pr";
  return ahead > 0 ? "publish" : "nothing";
}

/** @param {string} name the registry's latest for it, `0.0.0` when it has never heard of the package */
function latestOnRegistry(name) {
  try {
    return execFileSync("npm", ["view", name, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr);
    if (/E404/.test(stderr)) return "0.0.0";
    throw new Error(`CANNOT_TELL: the registry did not answer for ${name}: ${stderr}`, { cause: error });
  }
}

/**
 * @param {string} root
 * @param {(name: string) => string} [latest]
 * @returns {number} how many publishable packages are strictly ahead of the registry
 */
export function packagesAhead(root = "packages", latest = latestOnRegistry) {
  let ahead = 0;
  for (const dir of readdirSync(root)) {
    const path = join(root, dir, "package.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.private) continue;
    const registry = latest(manifest.name);
    const isNewer = isAhead(manifest.version, registry);
    console.error(`${isNewer ? "AHEAD of" : "not ahead of"} the registry: ${manifest.name}@${manifest.version} (latest there: ${registry})`);
    if (isNewer) ahead += 1;
  }
  return ahead;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pending = pendingChangesets();
  console.error(`changesets naming a release: ${pending}`);
  const mode = decideMode({ pending, ahead: pending > 0 ? 0 : packagesAhead() });
  console.log(`mode=${mode}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
}
