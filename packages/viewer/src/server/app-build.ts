import { fileURLToPath } from "node:url";

/**
 * The viewer app built from `src/app/` with esbuild: on demand in development, and once by
 * `writeViewerAssets` for the published CLI. The CLI bundle replaces this module with a stub
 * (`packages/cli/scripts/build.ts`), since it serves the prebuilt files instead.
 */

/**
 * Bundles `src/app/main.ts` into one minified ES module. esbuild is loaded only here.
 * @param external import paths left as they are (the served Mermaid files)
 */
export async function buildApp(external: string[]): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../app/main.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
    logLevel: "silent",
    external,
  });
  const code = result.outputFiles[0]?.text;
  if (code === undefined) throw new Error("esbuild produced no output for the viewer app");
  return code;
}

/** The app's stylesheet in `src/app/`. */
export function appStylesPath(): string {
  return fileURLToPath(new URL("../app/styles.css", import.meta.url));
}
