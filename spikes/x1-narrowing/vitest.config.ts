import { defineConfig } from "vitest/config";

// Spike-local config: pnpm exec vitest run --root spikes/x1-narrowing
// The root vitest config only includes packages/*, so root CI never runs this.
export default defineConfig({
  test: {
    include: ["*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
