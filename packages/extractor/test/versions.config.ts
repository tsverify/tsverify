/**
 * The extractor suite on one TypeScript, named by `TSVERIFY_TEST_TYPESCRIPT`:
 *
 *   pnpm --filter @tsverify/extractor test:ts5.9
 *   pnpm --filter @tsverify/extractor test:ts6
 *
 * The default suite runs on whatever `loadTypeScript` finds (`@typescript/typescript6` in this
 * TS-7 monorepo); `typescript-versions.test.ts` also checks the goldens on 5.9 there.
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
