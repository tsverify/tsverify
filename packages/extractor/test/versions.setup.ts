/**
 * Setup file of `versions.config.ts`: forces `loadTypeScript` to the package named by
 * `TSVERIFY_TEST_TYPESCRIPT` (`typescript59`, `@typescript/typescript6`, …), so the whole
 * extractor suite runs on that TypeScript.
 */
import { createRequire } from "node:module";
import { vi } from "vitest";
import type { LoadedTypeScript } from "../src/load-typescript";
import type { TypeScript } from "../src/typescript";

vi.mock(import("../src/load-typescript"), async (importOriginal) => {
  const original = await importOriginal();
  const name = process.env.TSVERIFY_TEST_TYPESCRIPT;
  if (!name) throw new Error("versions.config.ts: set TSVERIFY_TEST_TYPESCRIPT to a package name");
  const require = createRequire(import.meta.url);
  const path = require.resolve(name);
  const ts = require(path) as TypeScript;
  const forced: LoadedTypeScript = { ts, version: ts.version, path };
  return { ...original, loadTypeScript: () => forced };
});
