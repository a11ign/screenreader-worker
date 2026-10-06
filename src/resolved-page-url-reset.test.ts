/**
 * THE RESET'S POSITION IS THE FIX, AND NOTHING CHECKED IT — #71.
 *
 * `resolvedPageUrl` is module-level. `pageTarget()` reads it on its way to `choosePageTarget`, and it runs
 * at the TOP of `navigateExisting` — so a value surviving from the previous capture makes capture N+1 of
 * page B ask `choosePageTarget(expectedUrl = B, resolvedUrl = A)` while the reused window is still showing
 * A. **It fails in the direction that looks like success**: A is a real URL, so nothing throws and nothing
 * reads as absent; the guard simply accepts the previous page's document. `A11Y_REUSE_BROWSER` is on by
 * default, so that is the normal path.
 *
 * The fix moved `resolvedPageUrl = null` to the first statement of the function, and its comment says
 * *"`browser-session.test.ts` pins the ordering, because a statement's POSITION is the property here and
 * moving it back is a one-line edit that changes nothing a type or a lint check can see."*
 *
 * **It did not.** Measured 2026-09-09: moving the reset back inside the `try`, exactly where it used to
 * be, fails **none** of `browser-session.test.ts`'s 16 tests. The comment named a guard that was not
 * there — the #842 shape, in the file whose entire subject is a guard, and about the one property the
 * comment itself says nothing else can see.
 *
 * READ FROM SOURCE, because `navigateExisting` opens a WebSocket to a real Edge and cannot be called
 * here. A statement's position is a syntactic property, so reading the syntax is not a weaker check than
 * driving the function — it is the same check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { choosePageTarget } from "./browser-session.mjs";

const SOURCE = readFileSync(resolve(import.meta.dirname, "browser-session.mjs"), "utf8");

const navigateExistingBody = () => {
  const at = SOURCE.indexOf("export async function navigateExisting(url) {");
  assert.notEqual(at, -1, "navigateExisting is gone or renamed — this guard's subject, not a pass");
  const from = SOURCE.slice(at);
  return from.slice(0, from.indexOf("\n}\n"));
};

test("the reset is the FIRST statement of navigateExisting, before anything can read it", () => {
  const body = navigateExistingBody();
  const reset = body.indexOf("captureUrls.resolved = null;");
  const readsIt = body.indexOf("await pageTarget()");
  assert.ok(reset >= 0, "navigateExisting no longer resets `captureUrls.resolved` — the stale value is back");
  assert.ok(readsIt >= 0, "navigateExisting no longer calls pageTarget() — this guard has lost its subject");
  assert.ok(reset < readsIt,
    "`captureUrls.resolved = null` must precede `pageTarget()`. Below it, the previous capture's URL is what "
    + "`choosePageTarget` sees while the reused window still shows the previous page, and it reads as a "
    + "legitimate match rather than as an error");

  // FIRST, not merely earlier: anything awaited before it can yield, and a reset that is not the first
  // statement is a reset whose position is an accident of what happens to be above it.
  const firstStatement = body.split("\n").slice(1)
    .find((line) => line.trim() && !line.trim().startsWith("//") && !line.trim().startsWith("*"));
  assert.equal(firstStatement?.trim(), "captureUrls.resolved = null;",
    "the reset must be the first statement, not just an early one");
});

test("to null, NEVER to the requested URL", () => {
  // `resolvedNavigationUrl` returns the REQUESTED url when nothing redirected, so resetting to it would
  // make "nothing redirected" and "a previous capture redirected here" the same value — the row names
  // this explicitly, and it is the trap that makes the obvious fix wrong.
  const body = navigateExistingBody();
  assert.doesNotMatch(body, /resolvedPageUrl = url\b/,
    "resetting to the requested URL restores the ambiguity the reset exists to remove");
});

/**
 * AND THE OTHER HALF OF THE ROW, SETTLED RATHER THAN ASSUMED.
 *
 * The row reports the redirect gate comparing with `!==` as its first defect. It uses `sameDocument`
 * today, and the comment beside it argues the two cannot differ: the branch is reached only when nothing
 * matched `expectedUrl`, so if `resolvedUrl` is the same document as `expectedUrl`, nothing could match
 * that either.
 *
 * **The argument is sound and it was prose.** `sameDocument` reduces to `normalise(a) === normalise(b)`,
 * and equality of a function's outputs is transitive by construction — so the conclusion follows. This
 * drives it instead: the exact input the row predicts (a resolved URL differing from the requested one
 * ONLY by normalisation) gets the same answer under both spellings.
 */
test("`!==` and `sameDocument` cannot disagree in this branch — the row's first defect, measured", () => {
  const pages = [{ type: "page", url: "https://host/other", webSocketDebuggerUrl: "ws://a" }];
  // Differ only by normalisation: `.html` and a trailing slash, both of which `samePath` folds away.
  const expected = "https://host/survey.html";
  const resolvedOnlyByNormalisation = "https://host/survey/";

  const withSameDocument = choosePageTarget(pages, expected, resolvedOnlyByNormalisation);
  assert.ok(withSameDocument, "a usable page target must be returned");
  // Nothing matched what was asked for, and the resolved URL is the same document, so no page can match
  // it either: the answer is `fallback` under EITHER comparison. `!==` would enter the branch and find
  // nothing; `sameDocument` skips it. Same result, which is exactly what the comment claims.
  assert.equal(withSameDocument.targetMatch, "fallback",
    "a resolved URL differing only by normalisation must not produce a redirect match");

  // And the case where they genuinely differ still works — a real redirect to a real other document.
  const redirected = [
    { type: "page", url: "https://host/after-redirect", webSocketDebuggerUrl: "ws://b" },
  ];
  const real = choosePageTarget(redirected, "https://host/before", "https://host/after-redirect");
  assert.ok(real, "a usable page target must be returned — null here means the fixture, not the code");
  assert.equal(real.targetMatch, "matched", "a genuine redirect must still be recognised");
  assert.equal(real.resolvedUrl, "https://host/after-redirect",
    "and the resolved URL must ride along, so a reader can tell it from a plain match");
});
