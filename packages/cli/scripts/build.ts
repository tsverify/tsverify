/**
 * Publish-time build of `@tsverify/cli` (run by `prepack`, or `pnpm --filter @tsverify/cli build`):
 *
 * - `dist/tsverify.js`: the `tsverify` bin, one ESM bundle of `src/index.ts` for Node 22+. Every
 *   `@tsverify/*` workspace package is bundled in, except `@tsverify/runtime`, which generated
 *   tests import and which is published on its own. Every third-party package stays external and
 *   must be a `dependencies` entry of this package; the build fails otherwise. TypeScript is an
 *   optional peer (`typescript` or `@typescript/typescript6`), loaded at runtime from the
 *   analyzed project, so the build also fails if the bundle imports a peer statically.
 * - `dist/viewer/app.js` + `app.css`: the viewer's browser app, prebuilt so that an installed CLI
 *   never needs esbuild (`@tsverify/viewer`'s assets.ts picks them up next to the bundle, and its
 *   on-demand build, app-build.ts, is stubbed out of the bundle).
 * - `behavior.schema.json` at the package root, copied from `@tsverify/spec`, for editors
 *   (`node_modules/@tsverify/cli/behavior.schema.json`).
 *
 * Development is unaffected: `bin/tsverify.js` still runs `src/` through tsx.
 */
import { chmodSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeViewerAssets } from "@tsverify/viewer";
import { build, type Plugin } from "esbuild";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(PACKAGE_DIR, "dist");
const ENTRY = "tsverify.js";
/** Published separately: imported by generated tests, and resolved by `test-run.ts`. */
const RUNTIME = "@tsverify/runtime";
/** Replaces `@tsverify/viewer`'s app-build.ts in the bundle; only reached if dist/viewer/ is gone. */
const VIEWER_APP_BUILD_STUB = `
const missing = () => { throw new Error("tsverify view: dist/viewer/ is missing from the @tsverify/cli installation; reinstall it"); };
export const buildApp = async () => missing();
export const appStylesPath = missing;
`;

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;
const dependencies = manifest.dependencies ?? {};
const peerDependencies = manifest.peerDependencies ?? {};

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

const workspaceBundling: Plugin = {
  name: "tsverify-workspace",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      const name = packageName(args.path);
      if (name.startsWith("@tsverify/") && name !== RUNTIME) return undefined; // bundled
      return { path: args.path, external: true };
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
  banner: { js: "#!/usr/bin/env node" },
  // Whitespace and syntax only: identifiers stay readable in stack traces, and esbuild's
  // per-module path comments (`// src/main.ts`) are dropped.
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  plugins: [workspaceBundling],
});

const externals = new Set<string>();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external && !isBuiltin(imported.path)) externals.add(packageName(imported.path));
  }
}
const undeclared = [...externals].filter((name) => !(name in dependencies));
if (undeclared.length > 0) {
  throw new Error(
    `the bundle imports packages that @tsverify/cli does not depend on: ${undeclared.join(", ")}`,
  );
}
// The TypeScript peers come from the analyzed project, loaded at runtime (the extractor's
// loadTypeScript): a static import would make them hard requirements of every install.
const imported = Object.keys(peerDependencies).filter((name) => externals.has(name));
if (imported.length > 0) {
  throw new Error(
    `the bundle imports the peer dependencies ${imported.join(", ")} statically; load them at runtime`,
  );
}
chmodSync(join(DIST, ENTRY), 0o755);

await writeViewerAssets(join(DIST, "viewer"));

const require = createRequire(import.meta.url);
copyFileSync(
  require.resolve("@tsverify/spec/behavior.schema.json"),
  join(PACKAGE_DIR, "behavior.schema.json"),
);

const kb = (bytes: number) => `${Math.round(bytes / 1024)} kB`;
const entry = result.metafile.outputs[`dist/${ENTRY}`];
process.stdout.write(
  `built dist/${ENTRY} (${kb(entry?.bytes ?? 0)}), dist/viewer/, behavior.schema.json; ` +
    `external: ${[...externals].sort().join(", ")}\n`,
);
