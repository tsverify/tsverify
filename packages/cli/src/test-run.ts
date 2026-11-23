/**
 * Runs generated test files with vitest's programmatic API (`createVitest` + `start` from
 * `vitest/node`; the vitest found by `vitest-resolve.ts`, within its `VITEST_RANGE`), in-process:
 *
 * - `root` is the project root and `include` lists only the generated files, so the user's own
 *   tests never run;
 * - `config: false`: the user's vitest / vite config is not loaded (no setup files, plugins,
 *   fake timers or environments that the generated tests don't expect);
 * - `@tsverify/runtime` is aliased to this installation's runtime entry, so the project needs nothing
 *   installed besides tsverify and vitest (vitest resolves the generated files' `vitest` import
 *   itself);
 * - no reporters and `silent`, so nothing reaches stdout/stderr: results are read from the
 *   returned test modules, including each test's `task.meta`;
 * - vite's and vitest's caches go to `.tsverify/cache/`, not into the project's `node_modules`;
 * - the environment is set as the `vitest` command sets it before it starts (`TEST`, `VITEST`, and
 *   `NODE_ENV=test` unless set), and restored afterwards: `createVitest` alone leaves `NODE_ENV` to
 *   vite, which sets `development`, and the tests' workers inherit it, so code that loads differently
 *   under test (`process.env.NODE_ENV === "test" ? localDb : …`) would fail as the generated
 *   tests import it, though it loads under `vitest run`;
 * - the project tsconfig's `customConditions` (`conditions`) are added to vite's resolve
 *   conditions, so a workspace package that the project resolves to its sources (an `exports`
 *   entry such as `"@org/source": "./src/index.ts"`) resolves the same way in the tests.
 */
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResolvedVitest } from "./vitest-resolve";

/** Caches of the vitest run, relative to the project root (next to `.tsverify/generated`). */
export const CACHE_DIR = ".tsverify/cache";

/**
 * vite's own resolve conditions (vite 6 and later), kept when custom ones are set: setting
 * `resolve.conditions` replaces vite's defaults there, while vite 5 adds to them (and ignores
 * names no package uses, such as `development|production`).
 */
const VITE_CONDITIONS = ["module", "node", "development|production"];

export interface TestOutcome {
  /** Test file relative to the project root, `/`-separated. */
  file: string;
  name: string;
  state: "passed" | "failed" | "skipped" | "pending";
  /**
   * Failure messages (the test's errors, or the file's collection errors). An error with a cause
   * names the innermost one: vitest's "There was an error when mocking a module" says only that a
   * module mocked with `vi.mock` failed to load, its cause says why.
   */
  errors: string[];
  /** Each error in full, aligned with `errors`: its stack, then each cause's (`Caused by: …`). */
  details?: string[];
  /**
   * The test failed before it ran: its file could not be loaded (an import that doesn't resolve,
   * a module mock that can't be built, an error at the top level), so `errors` are the file's.
   */
  setup?: true;
  meta: Record<string, unknown>;
}

export interface TestRunOptions {
  /** Extra package `exports` conditions to resolve with (the tsconfig's `customConditions`). */
  conditions?: readonly string[];
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
 * @param runner the vitest to run them with (`findVitest`)
 */
export async function runGeneratedTests(
  root: string,
  include: string[],
  runner: ResolvedVitest,
  options: TestRunOptions = {},
): Promise<TestRunResult> {
  const conditions =
    options.conditions && options.conditions.length > 0
      ? [...options.conditions, ...VITE_CONDITIONS]
      : undefined;
  const { createVitest } = (await import(
    pathToFileURL(runner.nodeEntry).href
  )) as typeof import("vitest/node");
  const exitCode = process.exitCode;
  const restoreEnv = testEnv();
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
      resolve: {
        alias: { "@tsverify/runtime": runtimeEntry() },
        ...(conditions ? { conditions } : {}),
      },
      ...(conditions ? { ssr: { resolve: { conditions } } } : {}),
    },
  );
  try {
    const result = await vitest.start();
    const outcomes: TestOutcome[] = [];
    for (const module of result.testModules) {
      const file = relative(root, module.moduleId).split(sep).join("/");
      const moduleErrors = module.errors().map(describeError);
      for (const test of module.children.allTests()) {
        const r = test.result();
        const errors = (r.errors ?? []).map(describeError);
        const own = errors.length > 0 || r.state === "passed";
        const shown = own ? errors : moduleErrors;
        outcomes.push({
          file,
          name: test.name,
          state: r.state,
          errors: shown.map((e) => e.message),
          details: shown.map((e) => e.detail),
          meta: { ...test.meta() },
          ...(own || moduleErrors.length === 0 ? {} : { setup: true as const }),
        });
      }
      if (moduleErrors.length > 0 && module.children.size === 0) {
        outcomes.push({
          file,
          name: "",
          state: "failed",
          errors: moduleErrors.map((e) => e.message),
          details: moduleErrors.map((e) => e.detail),
          meta: {},
          setup: true,
        });
      }
    }
    return {
      outcomes,
      unhandled: result.unhandledErrors.map((e) => describeError(e).message),
    };
  } finally {
    await vitest.close();
    restoreEnv();
    // vitest marks failed runs on the process; the exit code is ours to decide.
    process.exitCode = exitCode;
  }
}

/**
 * Sets the environment as the `vitest` command does before it creates vitest (`TEST`, `VITEST`,
 * `NODE_ENV` unless set); returns a function that restores the previous values.
 */
function testEnv(): () => void {
  const names = ["TEST", "VITEST", "NODE_ENV"] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.TEST = "true";
  process.env.VITEST = "true";
  process.env.NODE_ENV ??= "test";
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** vitest's wrapper around an error thrown while it builds a `vi.mock` factory's module. */
const MOCK_WRAPPER = /There was an error when mocking a module/;

/** An error as vitest reports it (serialized: `message`, `name`, `stack`, `cause`). */
interface ReportedError {
  message?: unknown;
  name?: unknown;
  stack?: unknown;
  cause?: unknown;
}

/** `ConnectionError: DATABASE_URL is not set`; a plain `Error` is just its message. */
function errorText(e: ReportedError): string {
  const message = String(e.message ?? "");
  const name = typeof e.name === "string" ? e.name : "Error";
  return name === "Error" || message.startsWith(`${name}:`) ? message : `${name}: ${message}`;
}

/**
 * One error as `TestOutcome` keeps it: the message names the innermost cause (vitest's
 * mocking wrapper is replaced by what it wraps); the detail is every stack, outermost first.
 */
export function describeError(error: unknown): { message: string; detail: string } {
  if (typeof error !== "object" || error === null) {
    return { message: String(error), detail: String(error) };
  }
  const chain: ReportedError[] = [];
  for (
    let e: unknown = error;
    typeof e === "object" && e !== null && chain.length < 8;
    e = (e as ReportedError).cause
  ) {
    chain.push(e as ReportedError);
  }
  const outer = chain[0] as ReportedError;
  const root = chain[chain.length - 1] as ReportedError;
  let message = String(outer.message ?? error);
  if (chain.length > 1) {
    message = MOCK_WRAPPER.test(message)
      ? `a module the tests mock (vi.mock) failed to load: ${errorText(root)}`
      : `${message} (caused by ${errorText(root)})`;
  }
  const detail = chain
    .map((e, i) => {
      const text = typeof e.stack === "string" && e.stack !== "" ? e.stack : errorText(e);
      return i === 0 ? text : `Caused by: ${text}`;
    })
    .join("\n");
  return { message, detail };
}
