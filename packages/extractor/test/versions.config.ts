/**
 * The extractor suite on one TypeScript, named by `TSVERIFY_TEST_TYPESCRIPT`:
 *
 *   pnpm --filter @tsverify/extractor test:ts7.1
 *
 * The default suite runs on whatever `loadTypeScript` finds (the monorepo's `typescript` 7.0);
 * `typescript-versions.test.ts` also checks the goldens on 7.1 there.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The loader's own tests resolve real installs, which the forced loader would bypass.
    exclude: ["**/node_modules/**", "**/test/fixtures/**", "test/load-typescript.test.ts"],
    setupFiles: ["test/versions.setup.ts"],
  },
});
