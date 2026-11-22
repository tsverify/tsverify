import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions, Plugin } from "esbuild";
import { type BundledPackage, bundledPackages } from "./bundled-packages";

/**
 * The viewer app built from `src/app/` with esbuild: on demand in development (`buildApp`, with
 * Mermaid served from `node_modules`), and once by `writeViewerAssets` for the published CLI
 * (`buildBundledApp`, with the part of Mermaid the viewer uses bundled in). The CLI bundle
 * replaces this module with a stub (`packages/cli/scripts/build.ts`), since it serves the
 * prebuilt files instead.
 */

/** The import the app's mermaid-loader makes. Served from `node_modules` in development. */
export const MERMAID_IMPORT = "/vendor/mermaid/mermaid.esm.min.mjs";

const ENTRY = fileURLToPath(new URL("../app/main.ts", import.meta.url));
/** The viewer package: the builds' working directory, which metafile paths are relative to. */
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

const COMMON: BuildOptions = {
  absWorkingDir: PACKAGE_DIR,
  entryPoints: { app: ENTRY },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "silent",
};

/**
 * Bundles `src/app/main.ts` into one minified ES module. esbuild is loaded only here.
 * @param external import paths left as they are (the served Mermaid files)
 */
export async function buildApp(external: string[]): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({ ...COMMON, write: false, external });
  const code = result.outputFiles[0]?.text;
  if (code === undefined) throw new Error("esbuild produced no output for the viewer app");
  return code;
}

export interface BundledApp {
  /** Written files (absolute) and their sizes in bytes. */
  files: { path: string; bytes: number }[];
  /** npm packages with code in the bundle, sorted by name, for the third-party notices. */
  packages: BundledPackage[];
}

/**
 * Bundles the app **with** the part of Mermaid it uses into `outDir`: `app.js` plus code-split
 * `<chunksDir>/*.js`, loaded lazily (Mermaid only once a diagram is shown). The viewer renders
 * only `stateDiagram-v2` sources (`@tsverify/render`'s `toMermaid`), laid out with dagre, so
 * every other diagram type, layout engine and lazily loaded extra (KaTeX, icon packs) is left
 * out: their dynamic `import()`s become rejected promises, and Mermaid reports such a diagram as
 * one it cannot render.
 */
export async function buildBundledApp(outDir: string, chunksDir: string): Promise<BundledApp> {
  const { build } = await import("esbuild");
  const result = await build({
    ...COMMON,
    outdir: outDir,
    entryNames: "[name]",
    chunkNames: `${chunksDir}/[name]-[hash]`,
    splitting: true,
    write: true,
    metafile: true,
    plugins: [bundledMermaid],
  });
  return {
    files: Object.entries(result.metafile.outputs).map(([path, output]) => ({
      path: resolve(PACKAGE_DIR, path),
      bytes: output.bytes,
    })),
    packages: await bundledPackages(result.metafile, PACKAGE_DIR),
  };
}

/**
 * Lazily loaded Mermaid modules that the viewer needs: the state diagram and the dagre layout.
 * Matched against the basename of each dynamic `import()` in Mermaid's own files.
 */
const KEPT_LAZY_IMPORTS = /^(?:stateDiagram-v2|dagre)-[A-Za-z0-9_]+\.mjs$/;

/** Mermaid's files (and its parser package's), whose dynamic imports are trimmed. */
const MERMAID_FILES =
  /[\\/]node_modules[\\/](?:mermaid|@mermaid-js[\\/]parser)[\\/]dist[\\/].*\.mjs$/;

const DYNAMIC_IMPORT = /\bimport\(\s*(["'])([^"']+)\1\s*\)/g;

const bundledMermaid: Plugin = {
  name: "tsverify-bundled-mermaid",
  setup(b) {
    // The app's one Mermaid import → the package's ESM entry (`mermaid.core.mjs`), bundled.
    b.onResolve({ filter: /^\/vendor\/mermaid\// }, (args) => {
      if (args.path !== MERMAID_IMPORT) return { errors: [{ text: `unexpected ${args.path}` }] };
      return { path: createRequire(ENTRY).resolve("mermaid") };
    });
    b.onLoad({ filter: MERMAID_FILES }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const contents = source.replace(DYNAMIC_IMPORT, (match, _quote: string, specifier: string) =>
        KEPT_LAZY_IMPORTS.test(basename(specifier))
          ? match
          : `Promise.reject(new Error(${JSON.stringify(`tsverify view bundles only Mermaid's state diagrams; ${specifier} is left out`)}))`,
      );
      return { contents, loader: "js" };
    });
  },
};

/** The app's stylesheet in `src/app/`. */
export function appStylesPath(): string {
  return fileURLToPath(new URL("../app/styles.css", import.meta.url));
}
