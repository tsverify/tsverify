/**
 * Runs generated test files with vitest's programmatic API (`createVitest` + `start` from
 * `vitest/node`, vitest 5.1.1), in-process:
 *
 * - `root` is the project root and `include` lists only the generated files, so the user's own
 *   tests never run;
 * - `config: false`: the user's vitest / vite config is not loaded (no setup files, plugins,
 *   fake timers or environments that the generated tests don't expect);
 * - `@tsverify/runtime` is aliased to this installation's runtime entry, so the project needs nothing
 *   installed besides tsv (vitest resolves the generated files' `vitest` import itself);
 * - no reporters and `silent`, so nothing reaches stdout/stderr: results are read from the
 *   returned test modules, including each test's `task.meta`;
 * - vite's and vitest's caches go to `.tsv/cache/`, not into the project's `node_modules`.
 */
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Caches of the vitest run, relative to the project root (next to `.tsv/generated`). */
export const CACHE_DIR = ".tsv/cache";

export interface TestOutcome {
  /** Test file relative to the project root, `/`-separated. */
  file: string;
  name: string;
  state: "passed" | "failed" | "skipped" | "pending";
  /** Failure messages (the test's errors, or the file's collection errors). */
  errors: string[];
  meta: Record<string, unknown>;
}

export interface TestRunResult {
  outcomes: TestOutcome[];
  /** Errors vitest could not attribute to a test (e.g. an unhandled rejection). */
  unhandled: string[];
}

/** Absolute path of `@tsverify/runtime`'s entry, as resolved from the CLI. */
export function runtimeEntry(): string {
  return fileURLToPath(import.meta.resolve("@tsverify/runtime"));
}

/**
 * @param root absolute project root
 * @param include project-relative globs of the generated test files
 */
export async function runGeneratedTests(root: string, include: string[]): Promise<TestRunResult> {
  const { createVitest } = await import("vitest/node");
  const exitCode = process.exitCode;
  const vitest = await createVitest(
    "test",
    {
      root,
      config: false,
      include,
      watch: false,
      reporters: [{}],
      silent: true,
      // Generated tests use real timers and the scheduler's own step timeout (2 s).
      testTimeout: 20_000,
      fsModuleCachePath: join(root, CACHE_DIR, "vitest"),
    },
    {
      cacheDir: join(root, CACHE_DIR, "vite"),
      resolve: { alias: { "@tsverify/runtime": runtimeEntry() } },
    },
  );
  try {
    const result = await vitest.start();
    const outcomes: TestOutcome[] = [];
    for (const module of result.testModules) {
      const file = relative(root, module.moduleId).split(sep).join("/");
      const moduleErrors = module.errors().map((e) => e.message);
      for (const test of module.children.allTests()) {
        const r = test.result();
        const errors = (r.errors ?? []).map((e) => e.message);
        outcomes.push({
          file,
          name: test.name,
          state: r.state,
          errors: errors.length > 0 || r.state === "passed" ? errors : moduleErrors,
          meta: { ...test.meta() },
        });
      }
      if (moduleErrors.length > 0 && module.children.size === 0) {
        outcomes.push({ file, name: "", state: "failed", errors: moduleErrors, meta: {} });
      }
    }
    return {
      outcomes,
      unhandled: result.unhandledErrors.map((e) =>
        typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e),
      ),
    };
  } finally {
    await vitest.close();
    // vitest marks failed runs on the process; the exit code is ours to decide.
    process.exitCode = exitCode;
  }
}
