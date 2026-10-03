import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideMode, isAhead, namesARelease, packagesAhead, pendingChangesets } from "./release-plan.mjs";

function inTempDir<T>(files: Record<string, string>, body: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "release-plan-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a version is ahead only when STRICTLY newer than the registry's latest", () => {
  assert.equal(isAhead("0.1.0", "0.0.0"), true);
  assert.equal(isAhead("0.1.1", "0.1.0"), true);
  assert.equal(isAhead("1.0.0", "0.9.9"), true);
  assert.equal(isAhead("0.1.0", "0.1.0"), false);
  assert.equal(isAhead("0.1.0", "0.2.0"), false);
});

test("the 0.0.0 placeholder is never publishable, not against an unknown package and not against the reservation", () => {
  assert.equal(isAhead("0.0.0", "0.0.0"), false, "an E404 reads as 0.0.0");
  assert.equal(isAhead("0.0.0", "0.0.0-reserved.0"), false, "the chairman's reservation must not make 0.0.0 publishable");
  // THE CONTROL for the two lines above: the same reservation does not stop a real release.
  assert.equal(isAhead("0.1.0", "0.0.0-reserved.0"), true);
});

test("a local version that is not a plain x.y.z is refused, and so is a registry answer that is not a version", () => {
  assert.throws(() => isAhead("0.1.0-beta.1", "0.0.0"), /not a plain x\.y\.z/);
  assert.throws(() => isAhead("0.1.0", "latest"), /not an x\.y\.z/);
});

test("a changeset names a release only when its frontmatter says major, minor or patch", () => {
  assert.equal(namesARelease('---\n"@a11ign/screenreader-worker": minor\n---\n\nSomething.\n'), true);
  assert.equal(namesARelease("---\n---\n\nAn empty changeset names none.\n"), false);
  assert.equal(namesARelease('Prose with "@a11ign/screenreader-worker": minor but no frontmatter\n'), false);
  assert.equal(namesARelease('---\n---\n\n"pkg": minor in the body is not frontmatter\n'), false);
});

test("pending changesets are counted from the directory, README excluded", () => {
  const files = {
    ".changeset/README.md": '---\n"x": patch\n---\n',
    ".changeset/a.md": '---\n"@a11ign/screenreader-worker": patch\n---\n\nA.\n',
    ".changeset/empty.md": "---\n---\n",
    ".changeset/config.json": "{}",
  };
  inTempDir(files, (root) => assert.equal(pendingChangesets(join(root, ".changeset")), 1));
});

test("the mode is version-pr while a release is pending, then publish when ahead, else nothing", () => {
  assert.equal(decideMode({ pending: 1, ahead: 1 }), "version-pr", "a pending changeset wins: its version pull request comes first");
  assert.equal(decideMode({ pending: 0, ahead: 1 }), "publish");
  assert.equal(decideMode({ pending: 0, ahead: 0 }), "nothing");
});

test("packages ahead are counted from the manifests, private ones skipped, and a registry failure is not a reading", () => {
  const manifest = (name: string, version: string, extra = "") => `{"name":"${name}","version":"${version}"${extra}}`;
  const files = {
    "packages/a/package.json": manifest("@x/a", "0.2.0"),
    "packages/b/package.json": manifest("@x/b", "0.0.0"),
    "packages/c/package.json": manifest("@x/c", "9.9.9", ',"private":true'),
  };
  const registry: Record<string, string> = { "@x/a": "0.1.0", "@x/b": "0.0.0-reserved.0" };
  inTempDir(files, (root) => {
    const dir = join(root, "packages");
    assert.equal(packagesAhead(dir, (name) => registry[name]), 1);
    assert.throws(() => packagesAhead(dir, () => { throw new Error("CANNOT_TELL: 503"); }), /CANNOT_TELL/);
  });
});
