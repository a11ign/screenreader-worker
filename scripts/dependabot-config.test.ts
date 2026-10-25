import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkDependabotConfig } from "@a11ign/toolchain/dependabot-config";

// THIS REPOSITORY'S `.github/dependabot.yml` IS THE OUTPUT OF `dependabot-config --write` (A11-253, under A11-251), not a hand-written file. The check
// generates the file in memory from the toolchain this repository installs and compares it with the committed one; it asserts nothing about versions.
// To fix a failure, run `pnpm exec dependabot-config --write` and commit the result.
test(".github/dependabot.yml is exactly what `dependabot-config --write` produces", () => {
  const result = checkDependabotConfig({ root: fileURLToPath(new URL("..", import.meta.url)) });
  assert.ok(result.ok, result.message);
});
