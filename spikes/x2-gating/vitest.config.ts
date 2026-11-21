import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Small shared machine: keep the fork count low. Each test file is independent.
    maxWorkers: 2,
  },
});
