/**
 * Publish-time build of `@tsverify/cli` (run by `prepack`, or `pnpm --filter @tsverify/cli build`):
 *
 * - `dist/tsverify.js`: the `tsverify` bin, one ESM bundle of `src/index.ts` for Node 22+. Every
 *   `@tsverify/*` workspace package is bundled in, except `@tsverify/runtime`, which generated
 *   tests import and which is published on its own. Third-party packages are bundled too, unless
 *   they are `dependencies` or `peerDependencies` of this package (left external, installed or
 *   provided by the user). A bundled third-party package must be a `devDependencies` entry, so
 *   its version is pinned here; the build fails otherwise.
 * - `dist/viewer/`: the viewer's browser app with the part of Mermaid it uses (`app.js`,
 *   `app.css`, `chunks/`), prebuilt so that an installed CLI needs neither esbuild nor Mermaid
 *   (`@tsverify/viewer`'s assets.ts serves it from next to the bundle, and its on-demand build,
 *   app-build.ts, is stubbed out of the bundle).
 * - `dist/THIRD_PARTY_NOTICES.md`: the license texts of every bundled third-party package.
 * - `behavior.schema.json` at the package root, copied from `@tsverify/spec`, for editors
 *   (`node_modules/@tsverify/cli/behavior.schema.json`).
 *
 * Development is unaffected: `bin/tsverify.js` still runs `src/` through tsx.
 */
import { chmodSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPackages, writeViewerAssets } from "@tsverify/viewer";
import { build, type Plugin } from "esbuild";
import { type NoticePackage, thirdPartyNotices } from "./notices";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(PACKAGE_DIR, "dist");
const ENTRY = "tsverify.js";
const NOTICES = "THIRD_PARTY_NOTICES.md";
/** Replaces `@tsverify/viewer`'s app-build.ts in the bundle; only reached if dist/viewer/ is gone. */
const VIEWER_APP_BUILD_STUB = `
const missing = () => { throw new Error("tsverify view: dist/viewer/ is missing from the @tsverify/cli installation; reinstall it"); };
export const buildApp = async () => missing();
export const buildBundledApp = async () => missing();
export const appStylesPath = missing;
`;

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;
/**
 * Installed with the CLI, or provided by the user: never bundled. Includes `@tsverify/runtime`
 * (a dependency, published separately), which generated tests import and `test-run.ts` resolves.
 */
const external = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const devDependencies = manifest.devDependencies ?? {};

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

const bundling: Plugin = {
  name: "tsverify-bundling",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      const name = packageName(args.path);
      if (external.has(name)) return { path: args.path, external: true };
      if (name.startsWith("@tsverify/")) return undefined; // workspace: bundled
      if (name in devDependencies) return undefined; // third-party: bundled
      return {
        errors: [
          {
            text: `${args.path} is neither bundled (a devDependencies entry of @tsverify/cli) nor external (dependencies / peerDependencies)`,
          },
        ],
      };
    });
    // The CLI reads only `version` from its package.json: inline that, not the whole manifest.
    b.onLoad({ filter: /[\\/]cli[\\/]package\.json$/ }, () => ({
      contents: JSON.stringify({ version: manifest.version }),
      loader: "json",
    }));
    // The bundle serves the prebuilt viewer app (dist/viewer/), so the viewer's on-demand
    // esbuild build of src/app/ is left out.
    b.onLoad({ filter: /[\\/]viewer[\\/]src[\\/]server[\\/]app-build\.ts$/ }, () => ({
      contents: VIEWER_APP_BUILD_STUB,
      loader: "ts",
    }));
  },
};

rmSync(DIST, { recursive: true, force: true });

const result = await build({
  absWorkingDir: PACKAGE_DIR,
  entryPoints: { tsverify: "src/index.ts" },
  outdir: DIST,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Bundled CommonJS (yaml) calls `require` for Node built-ins, which an ES module lacks:
  // esbuild's `__require` shim uses this one.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __tsverifyCreateRequire } from "node:module";',
      "const require = __tsverifyCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Whitespace and syntax only: identifiers stay readable in stack traces, and esbuild's
  // per-module path comments (`// src/main.ts`) are dropped.
  minifyWhitespace: true,
  minifySyntax: true,
  // License texts go to THIRD_PARTY_NOTICES.md instead.
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  plugins: [bundling],
});

const externals = new Set<string>();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external && !isBuiltin(imported.path)) externals.add(packageName(imported.path));
  }
}
chmodSync(join(DIST, ENTRY), 0o755);

const bundled = await bundledPackages(result.metafile, PACKAGE_DIR);
for (const p of bundled) {
  if (devDependencies[p.name] !== p.version) {
    throw new Error(
      `dist/${ENTRY} bundles ${p.name}@${p.version}, but @tsverify/cli's devDependencies pin ${devDependencies[p.name] ?? "nothing"}`,
    );
  }
}

const viewer = await writeViewerAssets(join(DIST, "viewer"));

const notices: NoticePackage[] = [
  ...bundled.map((p) => ({ ...p, bundledIn: [`dist/${ENTRY}`] })),
  ...viewer.packages.map((p) => ({ ...p, bundledIn: ["dist/viewer/"] })),
];
writeFileSync(join(DIST, NOTICES), thirdPartyNotices(notices));

const require = createRequire(import.meta.url);
copyFileSync(
  require.resolve("@tsverify/spec/behavior.schema.json"),
  join(PACKAGE_DIR, "behavior.schema.json"),
);

const kb = (bytes: number) => `${Math.round(bytes / 1024)} kB`;
const entry = result.metafile.outputs[`dist/${ENTRY}`];
const viewerBytes = viewer.files.reduce((sum, f) => sum + f.bytes, 0);
const names = (packages: { name: string }[]) => packages.map((p) => p.name).join(", ");
process.stdout.write(
  [
    `built dist/${ENTRY} (${kb(entry?.bytes ?? 0)}), bundling ${names(bundled)}; external: ${[...externals].sort().join(", ")}`,
    `built dist/viewer/ (${kb(viewerBytes)} in ${viewer.files.length} files), bundling ${names(viewer.packages)}`,
    `wrote dist/${NOTICES} (${new Set(notices.map((p) => `${p.name}@${p.version}`)).size} packages), behavior.schema.json`,
    "",
  ].join("\n"),
);
