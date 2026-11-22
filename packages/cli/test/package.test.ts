import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { satisfies, VITEST_RANGE } from "../src/vitest-resolve";

// The published CLI is one bundle (scripts/build.ts): workspace packages are inlined, and so are
// their third-party dependencies, except the CLI's own `dependencies` and `peerDependencies`,
// which stay external. Every third-party package the bundle inlines is pinned in the CLI's
// `devDependencies`, at the same exact version as in the workspace package that uses it.

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  publishConfig?: { bin?: Record<string, string>; access?: string };
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8"));
}

const cli = manifest("cli");
const deps = cli.dependencies ?? {};
const devDeps = cli.devDependencies ?? {};
const RUNTIME = "@tsverify/runtime";
/** Bundled into dist/viewer/ at build time, never imported by the Node bundle. */
const BUILD_ONLY = new Set(["esbuild", "preact"]);
/** Bundled into dist/tsverify.js: pure-JS packages that nobody needs to install. */
const BUNDLED = ["cac", "picocolors", "yaml", "zod"];

const bundled = Object.keys(devDeps)
  .filter((name) => name.startsWith("@tsverify/"))
  .map((name) => name.slice("@tsverify/".length));

describe("@tsverify/cli package.json", () => {
  it("depends on the runtime and third-party packages only; workspace packages are bundled", () => {
    expect(deps[RUNTIME]).toBe("workspace:*");
    expect(Object.keys(deps).filter((n) => n.startsWith("@tsverify/"))).toEqual([RUNTIME]);
    expect(bundled.length).toBeGreaterThan(0);
    for (const dir of bundled) expect(manifest(dir).private).toBe(true);
  });

  it("pins every bundled package's dependencies at the exact workspace version", () => {
    for (const dir of bundled) {
      for (const [name, version] of Object.entries(manifest(dir).dependencies ?? {})) {
        if (name.startsWith("@tsverify/") || BUILD_ONLY.has(name)) continue;
        const pinned = deps[name] ?? devDeps[name];
        expect({ from: dir, name, version: pinned }).toEqual({ from: dir, name, version });
      }
    }
    for (const [name, version] of Object.entries({ ...deps, ...devDeps })) {
      if (!version.startsWith("workspace:")) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("bundles no TypeScript: it comes from the project, as either optional peer", () => {
    const TYPESCRIPTS = ["typescript", "@typescript/typescript6", "ts-morph", "@ts-morph/common"];
    for (const name of TYPESCRIPTS) expect(deps, name).not.toHaveProperty(name);
    for (const dir of bundled) {
      const own = Object.keys(manifest(dir).dependencies ?? {});
      expect({ from: dir, typescript: own.filter((n) => TYPESCRIPTS.includes(n)) }).toEqual({
        from: dir,
        typescript: [],
      });
    }
    expect(cli.peerDependencies).toMatchObject({
      "@typescript/typescript6": ">=6.0.0",
      typescript: ">=5.4",
    });
    expect(cli.peerDependenciesMeta).toMatchObject({
      "@typescript/typescript6": { optional: true },
      typescript: { optional: true },
    });
  });

  it("bundles the small pure-JS packages and Mermaid instead of depending on them", () => {
    for (const name of [...BUNDLED, "mermaid"]) {
      expect(deps, name).not.toHaveProperty(name);
      expect(cli.peerDependencies ?? {}, name).not.toHaveProperty(name);
    }
    for (const name of BUNDLED) expect(devDeps, name).toHaveProperty(name);
    // Mermaid is the viewer's build-time input only.
    expect(manifest("viewer").dependencies ?? {}).not.toHaveProperty("mermaid");
    expect(manifest("viewer").devDependencies?.mermaid).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("makes vitest an optional peer dependency in the range test-run.ts supports", () => {
    expect(deps).not.toHaveProperty("vitest");
    expect(cli.peerDependencies?.vitest).toBe(VITEST_RANGE);
    expect(cli.peerDependenciesMeta?.vitest).toEqual({ optional: true });
    // Development runs on a supported version.
    expect(satisfies(devDeps.vitest ?? "", VITEST_RANGE)).toBe(true);
  });

  it("keeps tsx for development only and publishes the bundle as the bin", () => {
    expect(deps).not.toHaveProperty("tsx");
    expect(cli.publishConfig?.bin).toEqual({ tsverify: "./dist/tsverify.js" });
    expect(cli.publishConfig?.access).toBe("public");
    expect(cli.private).toBeUndefined();
    expect(manifest("runtime").private).toBeUndefined();
    expect(manifest("runtime").version).toBe(cli.version);
  });
});
