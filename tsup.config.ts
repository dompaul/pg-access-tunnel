import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  // Installed alongside the package, so each app's bundler resolves it.
  external: ["ws"],
});
