import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The published CLI is one bundle (scripts/build.ts): workspace packages are inlined, so their
// third-party dependencies must be the CLI's own `dependencies`, at the same exact versions.

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: { bin?: Record<string, string>; access?: string };
}

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8"));
}

const cli = manifest("cli");
const deps = cli.dependencies ?? {};
const RUNTIME = "@tsverify/runtime";
/** Bundled into dist/viewer/app.js at build time, never imported by the Node bundle. */
const BUILD_ONLY = new Set(["esbuild", "preact"]);

const bundled = Object.keys(cli.devDependencies ?? {})
  .filter((name) => name.startsWith("@tsverify/"))
  .map((name) => name.slice("@tsverify/".length));

describe("@tsverify/cli package.json", () => {
  it("depends on the runtime and third-party packages only; workspace packages are bundled", () => {
    expect(deps[RUNTIME]).toBe("workspace:*");
    expect(Object.keys(deps).filter((n) => n.startsWith("@tsverify/"))).toEqual([RUNTIME]);
    expect(bundled.length).toBeGreaterThan(0);
    for (const dir of bundled) expect(manifest(dir).private).toBe(true);
  });

  it("declares every bundled package's dependencies at the exact workspace version", () => {
    for (const dir of bundled) {
      for (const [name, version] of Object.entries(manifest(dir).dependencies ?? {})) {
        if (name.startsWith("@tsverify/") || BUILD_ONLY.has(name)) continue;
        expect({ from: dir, name, version: deps[name] }).toEqual({ from: dir, name, version });
      }
    }
    for (const [name, version] of Object.entries(deps)) {
      if (name !== RUNTIME) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
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
