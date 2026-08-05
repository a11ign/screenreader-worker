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
  assert.equal(result.agrees, true);
  assert.deepEqual(result.disagreements, []);
});

test("a sweep reporting MORE than NVDA exposes is named a phantom", () => {
  // The real case: NVDA's Elements List said "1 of 1" for a page where the sweep produced a second,
  // non-existent landmark. That extra entry changed the evidence text and flipped a conformant page's
  // 3.3.2 score across its threshold.
  const result = crossCheckStructure({
    sweep: { landmark: 1 },
    elementsList: { landmark: 0 },
  });
  assert.equal(result.agrees, false);
  assert.deepEqual(result.disagreements, [{ type: "landmark", sweep: 1, elementsList: 0, kind: "phantom" }]);
});

test("a sweep reporting FEWER is named truncated, because the cause and fix differ", () => {
  const result = crossCheckStructure({ sweep: { heading: 1 }, elementsList: { heading: 4 } });
  assert.equal(result.disagreements[0].kind, "truncated");
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
    assert.deepEqual(result.disagreements, [], `absent counts must not be reported: ${JSON.stringify(elementsList)}`);
  }
  // ...and symmetrically, a type the sweep did not run.
  assert.deepEqual(crossCheckStructure({ sweep: {}, elementsList: { landmark: 2 } }).disagreements, []);
});

test("only the five types NVDA's dialog can list are compared", () => {
  // browseMode.py's ELEMENT_TYPES is (link, heading, formField, button, landmark). Graphics, lists and
  // table cells are swept but absent from the dialog, so they can never be cross-checked and must not
  // be reported as mismatches just because the dialog has no number for them.
  const result = crossCheckStructure({
    sweep: { graphic: 5, list: 2, tableCell: 9, heading: 1 },
    elementsList: { heading: 1 },
  });
  assert.equal(result.agrees, true);
});

test("comparing NOTHING is not agreement", () => {
  // The first version returned agrees:true here. On the guest, the Elements List probe was arrowing the
  // radio GROUP instead of the tree, so every count came back unparsed and was dropped -- and the
  // cross-check reported AGREES. A verification that passes when it read nothing is worse than none,
  // because it launders "unchecked" into "checked and fine".
  const result = crossCheckStructure({ sweep: { landmark: 3, heading: 2 }, elementsList: {} });
  assert.equal(result.compared, 0);
  assert.equal(result.agrees, false, "nothing was compared, so nothing can be said to agree");
  assert.deepEqual(result.disagreements, [], "and nothing disagreed either -- it is simply unverified");
});

test("agreement requires at least one type actually compared", () => {
  const result = crossCheckStructure({ sweep: { landmark: 1 }, elementsList: { landmark: 1 } });
  assert.equal(result.compared, 1);
  assert.equal(result.agrees, true);
});
