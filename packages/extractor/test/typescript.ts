import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTypeScript } from "../src/load-typescript";
import { type LoadedProject, loadProject } from "../src/project";
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

/** The tsconfig of `openProject`'s temp projects. */
const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, target: "es2022", lib: ["es2022"], types: [] },
  include: ["**/*.ts"],
});

/**
 * A temp TypeScript project of `files` (relative path → text), loaded with the installed
 * TypeScript. `close()` ends the compiler process and removes the directory.
 */
export function openProject(files: Record<string, string>): LoadedProject & { root: string } {
  installTypeScript();
  const root = mkdtempSync(join(tmpdir(), "tsverify-extractor-"));
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const loaded = loadProject(root);
  if ("error" in loaded) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(loaded.error);
  }
  return {
    ...loaded,
    close() {
      loaded.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
