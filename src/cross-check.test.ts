/**
 * Cross-checking the quick-nav sweeps against NVDA's Elements List.
 *
 * The sweeps are relative (they depend on caret position) and report whatever NVDA happened to speak,
 * so a truncated sweep and a phantom entry both look exactly like a correct result. The Elements List
 * is absolute and type-authoritative -- a row in the Landmarks list IS a landmark -- so it can tell
 * those three apart. This tests the comparison, which is the part that must not itself invent findings.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { crossCheckStructure, elementsListRowName } from "./capture-pure.mjs";

test("a row's name is read out of NVDA's tree-view chrome", () => {
  assert.equal(elementsListRowName("main, tree view item, focused, selected, expanded, 1 of 1, level 0"), "main");
  assert.equal(elementsListRowName("Cycle hire, tree view item, focused, selected, 1 of 1, level 0"), "Cycle hire");
  assert.equal(
    elementsListRowName("Hire duration; edit; invalid entry, tree view item, focused, selected, 1 of 2, level 0"),
    "Hire duration; edit; invalid entry",
  );
});

test("anything that is not a tree ROW yields no name, so it cannot be counted as one", () => {
  // The container announcement of an EMPTY tree. Treating this as a row would count a phantom element
  // for every type a page does not have.
  assert.equal(elementsListRowName("tree view, focused"), null);
  assert.equal(elementsListRowName("Type:, grouping"), null);
  assert.equal(elementsListRowName(""), null);
  assert.equal(elementsListRowName(undefined), null);
});

test("the position suffix is DISCARDED, not read as a total", () => {
  // The tempting shortcut -- parse "1 of 1" as the element count -- is wrong because the list is
  // hierarchical: a <main> containing a <form> announces "level 0 ... 1 of 1" with the form as a CHILD.
  // That number counts siblings at one level, so reading it as a document total undercounts every
  // nested structure. Measured on the guest; an earlier version of this probe did exactly that.
  assert.equal(elementsListRowName("main, tree view item, expanded, 1 of 1, level 0"), "main");
  assert.equal(elementsListRowName("form, tree view item, 1 of 1, level 1"), "form");
});

test("equal counts agree", () => {
  const result = crossCheckStructure({
    sweep: { heading: 2, landmark: 1, formField: 3 },
    elementsList: { heading: 2, landmark: 1, formField: 3 },
  });
  assert.equal(result.sameCounts, true);
  assert.deepEqual(result.differsOn, []);
});

test("a sweep reporting MORE than NVDA exposes is named a phantom", () => {
  // The real case: NVDA's Elements List said "1 of 1" for a page where the sweep produced a second,
  // non-existent landmark. That extra entry changed the evidence text and flipped a conformant page's
  // 3.3.2 score across its threshold.
  const result = crossCheckStructure({
    sweep: { landmark: 1 },
    elementsList: { landmark: 0 },
  });
  assert.equal(result.sameCounts, false);
  assert.deepEqual(result.differsOn, [{ type: "landmark", sweepEntries: 1, oracleDistinctNames: 0 }]);
});

test("a difference records BOTH raw numbers and renders no verdict", () => {
  // REPLACES "a sweep reporting FEWER is named truncated, because the cause and fix differ", which
  // asserted `kind: "truncated"`. The worker cannot justify that word: `sweep` is an ENTRY COUNT
  // (`structure.headings.length`) and the oracle's is a count of distinct NAMES, and those differ in both
  // directions for reasons that are not defects — two links sharing a name are two announcements and one
  // name; one landmark entry can announce several landmarks, and some announce none.
  //
  // Measured on 675 fresh protocol-7 captures, worker against host on the same evidence: the worker
  // agreed 51% of the time and called `link` phantom 191 times, while the host's `sweepCompleteness` —
  // which parses the announcements — was exact on 60 of 60. Its 13 landmark truncations were REAL.
  //
  // `parseAnnouncement` is TypeScript and this file is plain node on the guest, so the worker has no
  // grammar to do better with. It records; the host judges. known-gaps §13.
  const result = crossCheckStructure({ sweep: { heading: 1 }, elementsList: { heading: 4 } });
  assert.deepEqual(result.differsOn, [{ type: "heading", sweepEntries: 1, oracleDistinctNames: 4 }]);
  assert.ok(!("kind" in result.differsOn[0]),
    "a verdict the worker cannot compute must not be rendered; sweepCompleteness on the host decides");
});

test("an unread type is not a disagreement", () => {
  // An older worker, a dialog that would not open, or a row NVDA announced without a position suffix
  // all leave a count absent. Reporting that as a mismatch would make the cross-check cry wolf and
  // get switched off -- which is how a real signal dies.
  // Note this asserts on `disagreements`, NOT on `agrees`. An absent count must not be reported as a
  // mismatch, but it is also not evidence of agreement -- see "comparing NOTHING is not agreement".
  // Conflating those two is what let a probe that read the wrong control report success.
  for (const elementsList of [{}, { landmark: undefined }, { heading: 2 }]) {
    const result = crossCheckStructure({ sweep: { landmark: 3 }, elementsList });
    assert.deepEqual(result.differsOn, [], `absent counts must not be reported: ${JSON.stringify(elementsList)}`);
  }
  // ...and symmetrically, a type the sweep did not run.
  assert.deepEqual(crossCheckStructure({ sweep: {}, elementsList: { landmark: 2 } }).differsOn, []);
});

test("only the five types NVDA's dialog can list are compared", () => {
  // browseMode.py's ELEMENT_TYPES is (link, heading, formField, button, landmark). Graphics, lists and
  // table cells are swept but absent from the dialog, so they can never be cross-checked and must not
  // be reported as mismatches just because the dialog has no number for them.
  const result = crossCheckStructure({
    sweep: { graphic: 5, list: 2, tableCell: 9, heading: 1 },
    elementsList: { heading: 1 },
  });
  assert.equal(result.sameCounts, true);
});

test("comparing NOTHING is not agreement", () => {
  // The first version returned agrees:true here. On the guest, the Elements List probe was arrowing the
  // radio GROUP instead of the tree, so every count came back unparsed and was dropped -- and the
  // cross-check reported AGREES. A verification that passes when it read nothing is worse than none,
  // because it launders "unchecked" into "checked and fine".
  const result = crossCheckStructure({ sweep: { landmark: 3, heading: 2 }, elementsList: {} });
  assert.equal(result.compared, 0);
  assert.equal(result.sameCounts, false, "nothing was compared, so nothing can be said to agree");
  assert.deepEqual(result.differsOn, [], "and nothing disagreed either -- it is simply unverified");
});

test("agreement requires at least one type actually compared", () => {
  const result = crossCheckStructure({ sweep: { landmark: 1 }, elementsList: { landmark: 1 } });
  assert.equal(result.compared, 1);
  assert.equal(result.sameCounts, true);
});

test("a type with a raw count but no DISTINCT entry makes the basis mixed, never distinct-names", () => {
  // `distinct` being present does not mean it covered every type compared: the lookup falls back to the
  // raw element count type by type. Distinct names and element counts differ by 75% on real pages — that
  // measurement is the reason `distinct` exists — so a verdict labelled "distinct-names" that silently
  // compared one type on element counts is telling the reader the wrong thing about the disagreement.
  const result = crossCheckStructure({
    sweep: { heading: 3, link: 9 },
    elementsList: { heading: 3, link: 9, distinct: { heading: 3 } } as never,
  });
  assert.equal(result.compared, 2);
  assert.equal(result.basis, "mixed-distinct-names-and-element-counts");
});

test("distinct covering every compared type is reported as distinct-names", () => {
  const result = crossCheckStructure({
    sweep: { heading: 3, link: 4 },
    elementsList: { heading: 9, link: 9, distinct: { heading: 3, link: 4 } } as never,
  });
  assert.equal(result.basis, "distinct-names");
  assert.equal(result.sameCounts, true, "it must compare against distinct names, not the element counts");
});

// --- #737: `distinct` counts an UNNAMED element individually (#699, correct -- an unnamed graphic has no
// name to collapse toward another one under), which makes it an ELEMENT count for any type carrying
// unnamed members, not the "distinct NAMES" `oracleDistinctNames` claims to be. `capture-probes.mjs` now
// passes `${type}Unnamed` alongside `distinct` for exactly the one type that has it (`graphic`), and
// `authoritativeCount` subtracts it -- the identical correction `conformance.ts`'s `reachableCountOf`
// already applies to the coverage denominator, done here for the cross-check's own reported number. ---

test("#737 REGRESSION: calendly's real graphic capture (2026-09-09T12-59-26-678Z) -- 63 graphics, 38 "
  + "unnamed, distinct.graphic 61 -- reports 23, matching conformance.ts's already-fixed coverage "
  + "denominator, not 61 counting 38 nameless images as 38 distinct NAMES", () => {
  const result = crossCheckStructure({
    sweep: { graphic: 10 },
    elementsList: { graphic: 63, graphicUnnamed: 38, distinct: { graphic: 61 } } as never,
  });
  assert.deepEqual(result.differsOn, [{ type: "graphic", sweepEntries: 10, oracleDistinctNames: 23 }],
    "before this fix, oracleDistinctNames read 61 -- every one of the 38 unnamed graphics counted as its "
    + "own distinct NAME, which is what inflated this gap 61/10 instead of the real 23/10");
});

test("#737: a type with no `${type}Unnamed` field is UNAFFECTED -- the subtraction only fires when the "
  + "caller actually supplies the count to subtract, never inferred or defaulted", () => {
  const result = crossCheckStructure({
    sweep: { heading: 3 },
    elementsList: { heading: 9, distinct: { heading: 5 } } as never,
  });
  assert.deepEqual(result.differsOn, [{ type: "heading", sweepEntries: 3, oracleDistinctNames: 5 }],
    "no headingUnnamed was supplied, so distinct is reported as-is -- the fix must not touch types it "
    + "was never asked about");
});

test("#737: the subtraction never goes negative -- a nonsense count is clamped, never printed", () => {
  // The two numbers come from one mark and cannot disagree in practice, but a malformed elementsList
  // (an old capture format, a hand-built test fixture) must not turn into a negative "distinct names".
  const result = crossCheckStructure({
    sweep: { graphic: 1 },
    elementsList: { graphic: 5, graphicUnnamed: 99, distinct: { graphic: 5 } } as never,
  });
  assert.deepEqual(result.differsOn, [{ type: "graphic", sweepEntries: 1, oracleDistinctNames: 0 }]);
});

test("#737: THE CALL SITE'S OWN CONTRIBUTION -- without `graphicUnnamed` in `elementsList` (the exact "
  + "shape `capture-probes.mjs` produced before this fix), the cross-check has no way to tell an unnamed "
  + "element from a named one, and reports the inflated element count as though it were 61 distinct "
  + "names. The function-level fix alone cannot help a caller that never supplies the count to subtract "
  + "-- both halves of #737 are load-bearing", () => {
  const result = crossCheckStructure({
    sweep: { graphic: 10 },
    elementsList: { graphic: 63, distinct: { graphic: 61 } } as never,
  });
  assert.deepEqual(result.differsOn, [{ type: "graphic", sweepEntries: 10, oracleDistinctNames: 61 }]);
});

