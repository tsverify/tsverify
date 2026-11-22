import { loadTypeScript } from "../src/load-typescript";
import { type TypeScript, useTypeScript } from "../src/typescript";
import { FIXTURES } from "./helpers";

/**
 * Loads TypeScript as `extractAll` would for a fixture project and installs it for the analysis
 * modules, for unit tests that use them without `extractAll`. `versions.setup.ts` can force it.
 */
export function installTypeScript(): TypeScript {
  const loaded = loadTypeScript(FIXTURES);
  if ("error" in loaded) throw new Error(loaded.error);
  useTypeScript(loaded.ts);
  return loaded.ts;
}
