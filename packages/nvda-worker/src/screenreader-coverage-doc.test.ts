/**
 * THE MAP OF WHAT THE SCREEN READER DRIVES MUST NAME EVERY PROBE THAT EXISTS.
 *
 * `docs/screenreader-coverage.md` opens by saying what it is for: *"Anything we have not driven is not
 * evidence we are missing — it is a claim we cannot make."* CLAUDE.md sends every agent to it before adding
 * a probe, and describes a behaviour missing from that table as *"not a missing feature; it is a claim this
 * project cannot currently make."*
 *
 * Its own maintenance instruction was **"Keep it current when you add a probe"** — which is a rule asking a
 * human to remember, and this repo's position on those is that they get broken. Measured 2026-09-05:
 * **five of the ten entries in `PROBE_FLAGS` were absent from it**, including both probes added that day.
 * `probeArrows`, `probeTyping`, `probeFocusContext`, `probeDialog` and `probeFocusReveal` all drove real
 * evidence that the document bounding our claims did not mention.
 *
 * ## Why this document and not another
 *
 * `docs/coverage.md` is GENERATED from `criterion-coverage.ts` and pinned by `coverage-doc.test.ts`, so it
 * cannot drift. This one is hand-maintained, and the audit that found the gap noted that **no test read it
 * at all** — while thirteen other tests pin documents to code. It is the document with the strongest claim
 * on being true and the least protection.
 *
 * ## Deliberately a PRESENCE check, not a content check
 *
 * It asserts every probe flag is mentioned and that no phantom is claimed. It does not check the prose is
 * right — a test cannot know whether "press Escape twice" describes `probeDialog` correctly. Presence is
 * what was actually missing, and a test that pretended to more would be the coverage-that-examines-nothing
 * shape this file exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PROBE_FLAGS } from "./capture-pure.mjs";

const MAP = readFileSync(
  fileURLToPath(new URL("../../../docs/screenreader-coverage.md", import.meta.url)), "utf8");

test("every probe this worker can run is named in the map that bounds our claims", () => {
  // VACUITY GUARD. If `PROBE_FLAGS` were ever empty or unreadable, every assertion below would pass
  // having compared nothing — which is precisely the failure this document exists to prevent, one level up.
  assert.ok(PROBE_FLAGS.length >= 8, `expected the probe flags, found ${PROBE_FLAGS.length}`);
  assert.ok(MAP.length > 2000, "the coverage map is missing or truncated");

  for (const flag of PROBE_FLAGS) {
    assert.ok(MAP.includes(flag),
      `\`${flag}\` drives real evidence and docs/screenreader-coverage.md does not mention it. That `
      + "document is what tells the next reader which claims this project can make — CLAUDE.md calls a "
      + "behaviour missing from it \"a claim this project cannot currently make\". Add a row saying what "
      + "the user does, how it is driven, the field it lands in, and the criteria it serves.");
  }
});

test("the map claims no probe that does not exist, which is the other direction", () => {
  // A `probe*` name in the document that nothing implements is a claim about a capability we do not have —
  // worse than the omission, because the omission is at least visible as silence. The
  // `evidence-fields.test.ts` rule (a field in a list that no capture carries is a phantom), applied to a
  // document.
  //
  // A NAME MAY BE A WIRE FLAG **OR** A FUNCTION, and the first version of this test allowed only the
  // first — so it accused `probeFocusOrder`, `probeRouteChange` and `probeKindFor`, all of which are real
  // functions the document discusses in prose. That is a false positive on its own first run, and a new
  // gate that cries wolf is one somebody switches off. The property worth asserting is that the name
  // refers to SOMETHING, not that the document only ever discusses the wire.
  const source = [
    "capture-probes.mjs", "capture-pure.mjs", "capture-setup.mjs", "capture-core.mjs",
  ].map((f) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8")).join("\n");

  const implemented = (name: string) =>
    PROBE_FLAGS.includes(name) || new RegExp(`(function|const)\\s+${name}\\b`).test(source);

  const claimed = new Set([...MAP.matchAll(/\bprobe[A-Z][A-Za-z]*\b/g)].map((m) => m[0]));
  assert.ok(claimed.size >= 8, `found ${claimed.size} probe names in the map; the regex has drifted`);
  for (const name of claimed) {
    assert.ok(implemented(name),
      `docs/screenreader-coverage.md names \`${name}\`, which is neither a wire flag nor a function in the `
      + "capture source. Either it was removed and the map still advertises it, or it is a typo that reads "
      + "as a capability this project has.");
  }
});
