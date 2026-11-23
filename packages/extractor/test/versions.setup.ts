/**
 * Setup file of `versions.config.ts`: forces `loadTypeScript` to the package named by
 * `TSVERIFY_TEST_TYPESCRIPT` (`typescript71`, …), so the whole extractor suite runs on that
 * TypeScript.
 */
import { vi } from "vitest";

vi.mock(import("../src/load-typescript"), async (importOriginal) => {
  const original = await importOriginal();
  const name = process.env.TSVERIFY_TEST_TYPESCRIPT;
  if (!name) throw new Error("versions.config.ts: set TSVERIFY_TEST_TYPESCRIPT to a package name");
  const forced = original.loadTypeScriptPackage(name, import.meta.url);
  if ("error" in forced) throw new Error(forced.error);
  return { ...original, loadTypeScript: () => forced };
});
