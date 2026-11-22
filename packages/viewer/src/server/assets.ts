import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything the browser loads, all local: the page, the app bundle and Mermaid's prebuilt ESM
 * bundle from `node_modules`. Nothing is fetched from the network.
 *
 * The app bundle and its styles come from one of two places:
 * - **Prebuilt**, when `viewer/app.js` exists next to this module. The published CLI is one
 *   bundle (`dist/tsverify.js`) with the assets in `dist/viewer/`, written at build time by
 *   `writeViewerAssets`, so an installed tsverify needs no esbuild.
 * - **Built on demand** otherwise (development, from `src/`): `src/app/` is bundled with esbuild
 *   on first use and kept in memory.
 */

/** Prebuilt app bundle and styles, relative to {@link PREBUILT_DIR}. */
const APP_FILE = "app.js";
const STYLES_FILE = "app.css";
const PREBUILT_DIR = new URL("./viewer/", import.meta.url);

/** URL prefix under which Mermaid's `dist/` files are served. */
export const MERMAID_PREFIX = "/vendor/mermaid/";
/** The Mermaid entry module the app imports. */
export const MERMAID_ENTRY = "mermaid.esm.min.mjs";

/**
 * The only Mermaid files served: the entry and its lazily imported chunks. Anything else
 * (including any `..`) is a 404, so the route cannot reach outside `dist/`.
 */
const MERMAID_FILE = /^(?:mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[A-Za-z0-9_.-]+\.mjs)$/;

export interface Asset {
  body: string | Buffer;
  type: string;
}

export interface AppBundle {
  code: string;
  /** Wall-clock time to build (or read the prebuilt bundle). */
  ms: number;
}

/** A prebuilt asset next to this module, or undefined in development. */
function prebuilt(file: string): string | undefined {
  const path = fileURLToPath(new URL(file, PREBUILT_DIR));
  return existsSync(path) ? path : undefined;
}

let bundle: Promise<AppBundle> | undefined;

/** The app as one ES module, loaded once per process. */
export function appBundle(): Promise<AppBundle> {
  bundle ??= loadApp().catch((e: unknown) => {
    bundle = undefined;
    throw e;
  });
  return bundle;
}

async function loadApp(): Promise<AppBundle> {
  const start = performance.now();
  const file = prebuilt(APP_FILE);
  const code = file === undefined ? await buildApp() : await readFile(file, "utf8");
  return { code, ms: Math.round(performance.now() - start) };
}

/** Bundles `src/app/` with esbuild (a development-only dependency of the published CLI). */
async function buildApp(): Promise<string> {
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
    external: [`${MERMAID_PREFIX}*`],
  });
  const code = result.outputFiles[0]?.text;
  if (code === undefined) throw new Error("esbuild produced no output for the viewer app");
  return code;
}

function stylesPath(): string {
  return prebuilt(STYLES_FILE) ?? fileURLToPath(new URL("../app/styles.css", import.meta.url));
}

/**
 * Writes the prebuilt app bundle and styles into `outDir`, for a bundled build that places them
 * in `viewer/` next to its entry module (the CLI's `dist/viewer/`). Returns the written paths.
 */
export async function writeViewerAssets(outDir: string): Promise<string[]> {
  const app = join(outDir, APP_FILE);
  const styles = join(outDir, STYLES_FILE);
  await mkdir(outDir, { recursive: true });
  await writeFile(app, await buildApp());
  await copyFile(stylesPath(), styles);
  return [app, styles];
}

let styles: Promise<string> | undefined;

/** The page: inline styles, then the app module. */
export async function pageHtml(): Promise<string> {
  styles ??= readFile(stylesPath(), "utf8");
  const css = await styles;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>tsverify view</title>
<style>${css}</style>
</head>
<body>
<div id="app"><p class="loading">Loading…</p></div>
<noscript>tsverify view needs JavaScript.</noscript>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
}

let mermaidDir: string | undefined;

/**
 * A file of Mermaid's `dist/` (path relative to it), or undefined when it isn't served. Mermaid
 * is resolved from this module, i.e. from the CLI package once bundled.
 */
export async function mermaidAsset(path: string): Promise<Asset | undefined> {
  if (!MERMAID_FILE.test(path) || path.includes("..")) return undefined;
  mermaidDir ??= join(
    dirname(createRequire(import.meta.url).resolve("mermaid/package.json")),
    "dist",
  );
  try {
    return { body: await readFile(join(mermaidDir, path)), type: "text/javascript; charset=utf-8" };
  } catch {
    return undefined;
  }
}
