/**
 * Turn NVDA's own logging up, on demand, so a mute screen reader can be explained.
 *
 * The fault this exists for: NVDA goes mute on one guest and not its clones, and NVDA's log says
 * nothing about it. At the default level the whole session log is **seven lines**, ending at
 * "Loading config", with zero errors — identical on a healthy guest and a failing one. There is
 * simply no evidence in it, which is why "reinstall NVDA" was a guess rather than a diagnosis.
 *
 * `nvda.ini` lives under the worker's own `%LOCALAPPDATA%`, so unlike the Edge policy this needs no
 * elevation — the worker can do it itself.
 *
 * **Opt-in, via `A11Y_NVDA_LOG_LEVEL`.** Debug logging is not free: NVDA writes a great deal at that
 * level, and this pipeline is sensitive enough to per-capture timing that turning it on by default
 * would change the thing being measured. Set it when diagnosing, unset it afterwards.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** NVDA's own vocabulary. Anything else is refused rather than written blindly into a config file. */
const LEVELS = new Set(["DEBUG", "INFO", "WARNING", "ERROR", "OFF", "DEBUGWARNING"]);

/**
 * The `nvda.ini` body with `logLevel` set, or null when nothing needs changing.
 *
 * Pure, because the risky part is editing a config file that decides whether NVDA starts at all, and a
 * malformed edit is a dead worker. Handles both "the key exists" and "there is no [general] section".
 *
 * @param {string} body current file contents
 * @param {string} level one of LEVELS
 * @returns {string | null}
 */
export function withLogLevel(body, level) {
  if (!LEVELS.has(level)) return null;
  if (new RegExp(`^\\s*logLevel\\s*=\\s*${level}\\s*$`, "mi").test(body)) return null; // already set
  if (/^\s*logLevel\s*=/mi.test(body)) {
    return body.replace(/^\s*logLevel\s*=.*$/mi, `\tlogLevel = ${level}`);
  }
  // NVDA's ini is section-based; logLevel belongs under [general], which guidepup's config always has.
  if (/^\[general\]/mi.test(body)) {
    return body.replace(/^\[general\]/mi, `[general]\n\tlogLevel = ${level}`);
  }
  return `[general]\n\tlogLevel = ${level}\n${body}`;
}

/**
 * Apply `A11Y_NVDA_LOG_LEVEL` to every nvda.ini found. Returns the files changed.
 *
 * @param {string[]} configPaths from diagnostics.screenReaderState
 * @param {(line: string) => void} log
 */
export function applyRequestedLogLevel(configPaths, log) {
  const level = (process.env.A11Y_NVDA_LOG_LEVEL || "").toUpperCase();
  if (!level) return [];
  if (!LEVELS.has(level)) {
    log(`A11Y_NVDA_LOG_LEVEL=${level} is not an NVDA log level; ignoring it`);
    return [];
  }
  const changed = [];
  for (const path of configPaths) {
    try {
      const updated = withLogLevel(readFileSync(path, "utf8"), level);
      if (!updated) continue;
      writeFileSync(path, updated, "utf8");
      changed.push(path);
    } catch (error) {
      log(`could not set NVDA logLevel in ${path}: ${error.message}`);
    }
  }
  if (changed.length) log(`NVDA logLevel set to ${level} in ${changed.length} config(s); restart NVDA to apply`);
  return changed;
}
