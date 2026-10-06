import { defineToolchainConfig } from "@a11ign/toolchain/rstest-config";

export default defineToolchainConfig({
  root: import.meta.dirname,
  include: ["packages/*/src/**/*.test.ts", "scripts/*.test.ts"],
});
