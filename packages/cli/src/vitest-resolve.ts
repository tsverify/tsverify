/**
 * Finds the vitest that `tsverify test` runs the generated tests with. vitest is an optional
 * peer dependency of `@tsverify/cli`: only `tsverify test` needs it, so it is resolved at run
 * time, from the project root first (the vitest the project's own tests use), then from
 * tsverify's own location (e.g. installed next to it, or globally with it).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The vitest versions whose programmatic API `test-run.ts` uses (`createVitest` from
 * `vitest/node`, its options, `testModules`, `test.meta()`). Same as the `peerDependencies` range
 * in package.json (checked by test/package.test.ts). Each alternative is `^major.minor.patch`.
 *
 * Found by running `tsverify test` on examples/orders-app (clean and with the B3 overlay) with
 * each vitest installed in the project: 3.0.5–3.2.7, 4.0.1–4.1.12 and 5.0.0–5.1.1 give the same
 * results as the development version. 3.0.0–3.0.4 write a terminal escape to stdout (which
 * breaks `--format json`), 4.0.0 fails every test with today's vite ("Unknown method:
 * getBuiltins"), and 2.x has no `testModules`.
 */
export const VITEST_RANGE = "^3.0.5 || ^4.0.1 || ^5.0.0";

export interface ResolvedVitest {
  version: string;
  /** Absolute path of `vitest/node`'s entry. */
  nodeEntry: string;
  /** Where it was found. */
  from: "project" | "tsverify";
}

export type VitestLookup = { ok: true; vitest: ResolvedVitest } | { ok: false; message: string };

/** The message for a missing vitest. */
export const VITEST_MISSING =
  "tsverify test runs the generated tests with vitest, which isn't installed: npm i -D vitest\n";

/**
 * vitest for the project at `root`: from the project, else from tsverify's own location.
 * Fails with a message (for stderr, exit 2) when there is none, or when the one found is outside
 * {@link VITEST_RANGE}.
 * @param self where tsverify itself is (default: this module), for the fallback
 */
export function findVitest(root: string, self: string = import.meta.url): VitestLookup {
  const found = lookUp(root, "project") ?? lookUp(dirname(fileURLToPath(self)), "tsverify");
  if (found === undefined) return { ok: false, message: VITEST_MISSING };
  if (!satisfies(found.version, VITEST_RANGE) || found.nodeEntry === "") {
    const latest = Math.max(...alternatives(VITEST_RANGE).map(([major]) => major));
    return {
      ok: false,
      message:
        `tsverify test needs vitest ${VITEST_RANGE}, but the vitest it found is ${found.version} ` +
        `(${found.packageJson}): npm i -D vitest@${latest}\n`,
    };
  }
  const { packageJson: _, ...vitest } = found;
  return { ok: true, vitest };
}

/**
 * The nearest `node_modules/vitest` at or above `dir`, as Node's resolution walks up (without
 * NODE_PATH or global folders, so the result depends on the directory alone).
 */
function lookUp(
  dir: string,
  from: ResolvedVitest["from"],
): (ResolvedVitest & { packageJson: string }) | undefined {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const packageJson = join(current, "node_modules", "vitest", "package.json");
    if (existsSync(packageJson)) {
      const { version } = JSON.parse(readFileSync(packageJson, "utf8")) as { version: string };
      let nodeEntry = "";
      try {
        // Resolved from vitest's own package.json: a self-reference through its `exports`.
        nodeEntry = createRequire(realpathSync(packageJson)).resolve("vitest/node");
      } catch {
        // Too old to export `vitest/node`, or broken: the caller reports it as unusable.
      }
      return { version, nodeEntry, from, packageJson };
    }
    if (dirname(current) === current) return undefined;
  }
}

/** `^4.1.0 || ^5.0.0` → `[[4, 1, 0], [5, 0, 0]]`. */
function alternatives(range: string): [number, number, number][] {
  return range.split("||").map((part) => {
    const match = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/.exec(part);
    if (!match) throw new Error(`unsupported range alternative: ${part}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  });
}

/**
 * Whether `version` satisfies a range of `^x.y.z` alternatives (majors ≥ 1). A prerelease
 * (`5.2.0-beta.1`) counts as its release.
 */
export function satisfies(version: string, range: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const v = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return alternatives(range).some(
    ([major, minor, patch]) =>
      v[0] === major && (v[1] > minor || (v[1] === minor && v[2] >= patch)),
  );
}
