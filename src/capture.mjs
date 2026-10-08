// @ts-check
// capture.mjs — standalone NVDA capture CLI.
// Usage: node capture.mjs <url> <outFile> [steps] [--auth <plan.json>]
// MUST run in an interactive desktop session (NVDA needs a real desktop).
//
// `--auth <plan.json>` signs in first (a11y-witness #4171, #4084 outcome 1, prerequisite of #4107). The file is the wire `auth` object a
// capture request carries (`{ login: [...], idpOrigins?: [...] }`; see src/README.md), its credentials are the plan's `fromEnv` NAMES, and
// THIS process's environment supplies them. It is the one authenticated capture that needs no remote channel: the CLI refuses a remote
// `--worker` for an auth request and the server answers 403 to a non-loopback peer (ADR 0038, Constraint 1), so a run on the worker's own
// machine is the only shape that exists. The credentials must be fakes that belong to no account; the transcript is written to <outFile>.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { authOptionsFor } from "./auth-flow.mjs";
import { captureWithNvda, loginMarkOverride } from "./capture-core.mjs";

const DEFAULT_URL = "https://example.com";
const DEFAULT_OUT_FILE = "transcript.json";
const DEFAULT_STEPS = 150;
const SWITCH = "A11Y_DIAG_SKIP_LOGIN_MARK";
const HEADING_PHRASE = /\bheading\b/i;

/**
 * @typedef {{
 *   argv: string[],
 *   env?: Record<string, string | undefined>,
 *   capture?: (url: string, opts: Record<string, unknown>) => Promise<{ transcript: string[] }>,
 *   readText?: (path: string) => string,
 *   writeText?: (path: string, text: string) => void,
 *   log?: (line: string) => void,
 * }} LocalCapture
 */

/** @param {string[]} argv */
function readArguments(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { auth: { type: "string" } }, allowPositionals: true, strict: true });
  const [url = DEFAULT_URL, outFile = DEFAULT_OUT_FILE, steps = DEFAULT_STEPS] = positionals;
  return { url, outFile, steps: Number(steps), authFile: values.auth };
}

/**
 * The plan in `authFile`, validated by the worker's own validator and with every variable it reads checked present BEFORE anything is
 * launched, so an unset credential never becomes an empty one typed into a form. Neither the file's text nor a value is quoted in an error.
 *
 * @param {{ authFile: string, url: string, env: Record<string, string | undefined>, readText: (path: string) => string }} ctx
 */
function authOptionsFromFile({ authFile, url, env, readText }) {
  let raw;
  try {
    raw = JSON.parse(readText(authFile));
  } catch (cause) {
    throw new Error(`--auth ${authFile} is not JSON a plan can be read from (it is the wire "auth" object; see src/README.md)`, { cause });
  }
  return authOptionsFor({ parsed: { auth: raw, url }, env });
}

/**
 * Which of the two runs this process is, said before the capture so a run that fails still says it. Read through `loginMarkOverride`, the
 * one place that decides what counts as set (only the exact value `1`), so this line cannot disagree with what the login does.
 *
 * @param {Record<string, string | undefined>} env
 */
function switchLine(env) {
  const noDiag = { entries: [], sinceStart: () => 0, mark: () => undefined };
  const suppressed = loginMarkOverride({ diag: noDiag, env }).markNavigated !== undefined;
  return suppressed
    ? `${SWITCH}: set -- the login does NOT mark the window navigated; this is the CONTROL run, not a product reading`
    : `${SWITCH}: not set -- the login marks the window navigated, as it ships`;
}

/**
 * What NVDA announced as the page's heading: the first phrase of the transcript that names one. The transcript begins after the login
 * has ended and the page has settled, so this is the signed-in page, or nothing.
 *
 * @param {string[]} transcript
 */
function headingLine(transcript) {
  const heading = transcript.find((phrase) => HEADING_PHRASE.test(phrase));
  return heading === undefined
    ? `NO HEADING announced among ${transcript.length} phrases`
    : `HEADING NVDA announced: ${JSON.stringify(heading)}`;
}

/**
 * One capture on THIS machine. Every collaborator is a parameter so the tests drive it on fakes; the defaults are the real ones.
 *
 * @param {LocalCapture} ctx
 */
export async function runLocalCapture({
  argv, env = process.env, capture = captureWithNvda, readText = (path) => readFileSync(path, "utf8"),
  writeText = writeFileSync, log = console.log,
}) {
  const { url, outFile, steps, authFile } = readArguments(argv);
  const authOptions = authFile === undefined ? {} : authOptionsFromFile({ authFile, url, env, readText });
  log(switchLine(env));
  log(`capturing ${url}${authFile === undefined ? "" : " (signed in from the plan in the environment of this process)"}`);
  const result = await capture(url, { steps, ...authOptions });
  writeText(outFile, JSON.stringify(result, null, 2));
  log(`WROTE ${outFile} - ${result.transcript.length} phrases`);
  if (authFile !== undefined) log(headingLine(result.transcript));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalCapture({ argv: process.argv.slice(2) })
    .catch((e) => { console.error("CAPTURE_ERROR", (e && e.stack) || e); process.exitCode = 1; });
}
