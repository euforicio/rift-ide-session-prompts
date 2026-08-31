// Test-only config. `bb plugin build` reads the `@/*` alias out of
// tsconfig.json itself, but vitest runs on vite, which does not — so the same
// alias is restated here. This file has no effect on the shipped bundles.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
