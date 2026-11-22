import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Everything the browser loads, all from this package: the page, the app bundle (built from
 * `src/app/` with esbuild on first use, then kept in memory) and Mermaid's prebuilt ESM bundle
 * from `node_modules`. Nothing is fetched from the network.
 */

const APP_ENTRY = fileURLToPath(new URL("../app/main.ts", import.meta.url));
const STYLES = fileURLToPath(new URL("../app/styles.css", import.meta.url));

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
  /** Wall-clock build time. */
  ms: number;
}

let bundle: Promise<AppBundle> | undefined;

/** The app as one ES module, built once per process. */
export function appBundle(): Promise<AppBundle> {
  bundle ??= buildApp().catch((e: unknown) => {
    bundle = undefined;
    throw e;
  });
  return bundle;
}

async function buildApp(): Promise<AppBundle> {
  const start = performance.now();
  const result = await build({
    entryPoints: [APP_ENTRY],
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
  return { code, ms: Math.round(performance.now() - start) };
}

let styles: Promise<string> | undefined;

/** The page: inline styles, then the app module. */
export async function pageHtml(): Promise<string> {
  styles ??= readFile(STYLES, "utf8");
  const css = await styles;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>tsv view</title>
<style>${css}</style>
</head>
<body>
<div id="app"><p class="loading">Loading…</p></div>
<noscript>tsv view needs JavaScript.</noscript>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
}

let mermaidDir: string | undefined;

/** A file of Mermaid's `dist/` (path relative to it), or undefined when it isn't served. */
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
