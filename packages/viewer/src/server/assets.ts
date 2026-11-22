import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appStylesPath, buildApp, buildBundledApp } from "./app-build";
import type { BundledPackage } from "./bundled-packages";

/**
 * Everything the browser loads, all local: the page, the app bundle and Mermaid. Nothing is
 * fetched from the network.
 *
 * The app and Mermaid come from one of two places:
 * - **Prebuilt**, when `viewer/app.js` exists next to this module (or in the directory passed as
 *   `startViewer`'s `assets`). The published CLI is one bundle (`dist/tsverify.js`) with the
 *   viewer in `dist/viewer/`, written at build time by `writeViewerAssets`: `app.js`, `app.css`,
 *   and `chunks/*.js`, the lazily loaded part of Mermaid the viewer uses. An installed tsverify
 *   needs neither esbuild nor Mermaid.
 * - **Built on demand** otherwise (development, from `src/`): `src/app/` is bundled with esbuild
 *   on first use (`app-build.ts`) and kept in memory, and Mermaid's own prebuilt ESM build is
 *   served from `node_modules` under `/vendor/mermaid/`.
 */

/** Prebuilt app bundle and styles, relative to the prebuilt directory. */
const APP_FILE = "app.js";
const STYLES_FILE = "app.css";
/** Lazily loaded chunks, in the prebuilt directory and under `/` (`app.js` imports `./chunks/…`). */
const CHUNKS_DIR = "chunks";
const DEFAULT_PREBUILT_DIR = fileURLToPath(new URL("./viewer/", import.meta.url));

/** URL prefix of the prebuilt chunks (`<prebuilt>/chunks/`). */
export const CHUNKS_PREFIX = `/${CHUNKS_DIR}/`;
/** URL prefix under which Mermaid's `dist/` files are served in development. */
export const MERMAID_PREFIX = "/vendor/mermaid/";

/** The only chunk names served: esbuild's `[name]-[hash].js`, never a path. */
const CHUNK_FILE = /^[A-Za-z0-9_.-]+\.js$/;

/**
 * The only Mermaid files served: the entry and its lazily imported chunks. Anything else
 * (including any `..`) is a 404, so the route cannot reach outside `dist/`.
 */
const MERMAID_FILE = /^(?:mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[A-Za-z0-9_.-]+\.mjs)$/;

const JS = "text/javascript; charset=utf-8";

export interface Asset {
  body: string | Buffer;
  type: string;
}

export interface AppBundle {
  code: string;
  /** Wall-clock time to build (or read the prebuilt bundle). */
  ms: number;
}

/** What one viewer serves, from a prebuilt directory if it has `app.js`, else built on demand. */
export interface Assets {
  /** True when serving a prebuilt directory. */
  prebuilt: boolean;
  /** The app as one ES module, loaded once. */
  appBundle(): Promise<AppBundle>;
  /** The page: inline styles, then the app module. */
  pageHtml(): Promise<string>;
  /** A prebuilt chunk (`/chunks/<file>`), or undefined. */
  chunk(file: string): Promise<Asset | undefined>;
  /** A file of Mermaid's `dist/` (development only), or undefined. */
  mermaid(path: string): Promise<Asset | undefined>;
}

/** @param dir a prebuilt directory (`writeViewerAssets` output); default `viewer/` next to this module */
export function viewerAssets(dir = DEFAULT_PREBUILT_DIR): Assets {
  const prebuilt = existsSync(join(dir, APP_FILE));
  let bundle: Promise<AppBundle> | undefined;
  let styles: Promise<string> | undefined;
  return {
    prebuilt,
    appBundle() {
      bundle ??= loadApp(prebuilt ? join(dir, APP_FILE) : undefined).catch((e: unknown) => {
        bundle = undefined;
        throw e;
      });
      return bundle;
    },
    async pageHtml() {
      styles ??= readFile(prebuilt ? join(dir, STYLES_FILE) : appStylesPath(), "utf8");
      return page(await styles);
    },
    async chunk(file) {
      if (!prebuilt || !CHUNK_FILE.test(file) || file.startsWith(".")) return undefined;
      return readAsset(join(dir, CHUNKS_DIR, file));
    },
    // Development only: the prebuilt app has Mermaid in its chunks, and an installed CLI has no
    // Mermaid package to serve.
    async mermaid(path) {
      return prebuilt ? undefined : mermaidAsset(path);
    },
  };
}

async function loadApp(file: string | undefined): Promise<AppBundle> {
  const start = performance.now();
  const code = file === undefined ? await devBundle() : await readFile(file, "utf8");
  return { code, ms: Math.round(performance.now() - start) };
}

let dev: Promise<string> | undefined;

/** The app built from `src/app/`, with the served Mermaid files left external. Once per process. */
function devBundle(): Promise<string> {
  dev ??= buildApp([`${MERMAID_PREFIX}*`]).catch((e: unknown) => {
    dev = undefined;
    throw e;
  });
  return dev;
}

async function readAsset(path: string): Promise<Asset | undefined> {
  try {
    return { body: await readFile(path), type: JS };
  } catch {
    return undefined;
  }
}

export interface ViewerAssetsBuild {
  /** Written files (absolute) and their sizes in bytes. */
  files: { path: string; bytes: number }[];
  /** npm packages bundled into the app (Preact, Mermaid and its dependencies), sorted by name. */
  packages: BundledPackage[];
}

/**
 * Writes the prebuilt viewer into `outDir` (emptied first), for a bundled build that places it
 * in `viewer/` next to its entry module (the CLI's `dist/viewer/`): `app.js`, `app.css`, and
 * `chunks/` with the part of Mermaid the viewer uses.
 */
export async function writeViewerAssets(outDir: string): Promise<ViewerAssetsBuild> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const app = await buildBundledApp(outDir, CHUNKS_DIR);
  const styles = join(outDir, STYLES_FILE);
  await copyFile(appStylesPath(), styles);
  const stylesBytes = (await readFile(styles)).length;
  return {
    files: [...app.files, { path: styles, bytes: stylesBytes }].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    packages: app.packages,
  };
}

function page(css: string): string {
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
 * A file of Mermaid's `dist/` (path relative to it), or undefined when it isn't served or
 * Mermaid isn't installed. Resolved from this module (development: the viewer package).
 */
async function mermaidAsset(path: string): Promise<Asset | undefined> {
  if (!MERMAID_FILE.test(path) || path.includes("..")) return undefined;
  try {
    mermaidDir ??= join(
      dirname(createRequire(import.meta.url).resolve("mermaid/package.json")),
      "dist",
    );
  } catch {
    return undefined;
  }
  return readAsset(join(mermaidDir, path));
}
