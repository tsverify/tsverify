/**
 * Vitest results of the generated tests → findings:
 *
 * | Generated test                          | Finding                                   |
 * |-----------------------------------------|-------------------------------------------|
 * | path / forbidden / guard test fails     | `generated-test-failed` (error), at the impl's write |
 * | replay verdict `confirmed`              | `replay-confirmed` (error)                |
 * | replay verdict `confirmed-divergent`    | `replay-confirmed` (error), with a note on the divergence |
 * | replay verdict `replay-disagrees`       | `replay-disagrees` (warning)              |
 * | replay verdict `inconclusive`           | `unanalyzable` (info)                     |
 * | replay test fails without a verdict     | `generated-test-failed` (error): it could not run |
 * | test files fail before their tests run  | one `generated-test-failed` (error) per distinct error, `…:setup:<first file>`, with a setup hint and the original error (its innermost cause), in full in `detail` |
 *
 * A test fails "before it runs" (a setup failure, not a behavior one) when vitest could not load
 * its file (`TestOutcome.setup`: an import that doesn't resolve, a module mock that can't be
 * built), or its error says so (`SETUP_ERROR`).
 *
 * Replay verdicts come from `task.meta.tsverifyReplay`, which every generated replay test sets
 * before its assertion (see packages/testgen/README.md). A `replay-confirmed` finding has
 * `causedBy` the `tsverify check` finding it replayed, when that finding is in `sources`.
 */
import type { Finding, Trace } from "@tsverify/ir";
import type { GeneratedTest } from "@tsverify/testgen";
import type { TestOutcome } from "./test-run";

/** What a generated replay test stores in `task.meta.tsverifyReplay`. */
export interface ReplayMeta {
  verdict: "confirmed" | "confirmed-divergent" | "replay-disagrees" | "inconclusive";
  followed: boolean;
  violated?: boolean;
  divergence?: { kind: string; stepIndex: number; worker: string; message: string };
  status?: unknown;
  effects?: Record<string, number>;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  /** Tests vitest did not report (never ran). */
  missing: number;
}

export interface MapInput {
  behavior: string;
  /** Generated directory relative to the project root (e.g. `.tsverify/generated/order-lifecycle`). */
  outDir: string;
  tests: readonly GeneratedTest[];
  outcomes: readonly TestOutcome[];
  /** The `tsverify check` findings the replays came from, by id. */
  sources: ReadonlyMap<string, Finding>;
}

export function testFindings(input: MapInput): { findings: Finding[]; counts: TestCounts } {
  const { behavior, outDir, tests, outcomes, sources } = input;
  const byKey = new Map(outcomes.map((o) => [`${o.file}\n${o.name}`, o]));
  const counts: TestCounts = { total: tests.length, passed: 0, failed: 0, missing: 0 };
  const findings: Finding[] = [];
  // Setup failures, by their first error: usually one cause fails every file the same way.
  const setup = new Map<
    string,
    { files: string[]; tests: number; error: string; detail?: string }
  >();
  for (const test of tests) {
    const file = `${outDir}/${test.file}`;
    const outcome = byKey.get(`${file}\n${test.name}`) ?? byKey.get(`${file}\n`);
    if (outcome === undefined) {
      counts.missing++;
      findings.push(failed(behavior, file, test, { errors: ["vitest did not run this test"] }));
      continue;
    }
    if (outcome.state === "passed") counts.passed++;
    else counts.failed++;
    if (outcome.state !== "passed" && isSetupFailure(outcome)) {
      const error = firstError(outcome.errors);
      const detail = outcome.details?.[0];
      const seen = setup.get(error) ?? {
        files: [],
        tests: 0,
        error,
        ...(detail === undefined ? {} : { detail }),
      };
      if (!seen.files.includes(file)) seen.files.push(file);
      seen.tests++;
      setup.set(error, seen);
      continue;
    }

    if (test.kind !== "replay") {
      if (outcome.state !== "passed") findings.push(failed(behavior, file, test, outcome));
      continue;
    }
    const meta = outcome.meta.tsverifyReplay as ReplayMeta | undefined;
    const source = test.finding === undefined ? undefined : sources.get(test.finding);
    if (meta === undefined) {
      if (outcome.state !== "passed") findings.push(failed(behavior, file, test, outcome));
      continue;
    }
    findings.push(replayFinding(behavior, file, test, meta, source));
  }
  for (const failure of setup.values()) findings.push(setupFailed(behavior, failure));
  return { findings, counts };
}

/**
 * Errors that mean a test never got to the code under test: a module that doesn't resolve or
 * load, or a mock vitest couldn't build.
 */
const SETUP_ERROR =
  /Failed to resolve (entry for package|import)|Cannot find (module|package)|Failed to load url|does not provide an export named|error when mocking a module|module the tests mock \(vi\.mock\) failed to load|ERR_MODULE_NOT_FOUND/;

function isSetupFailure(outcome: TestOutcome): boolean {
  return outcome.setup === true || outcome.errors.some((e) => SETUP_ERROR.test(e));
}

/** One finding for the tests in `files` that failed before they ran, with the same `error`. */
function setupFailed(
  behavior: string,
  {
    files,
    tests,
    error,
    detail,
  }: { files: string[]; tests: number; error: string; detail?: string },
): Finding {
  const names = files.map((f) => f.slice(f.lastIndexOf("/") + 1));
  const dir = (files[0] ?? "").slice(0, (files[0] ?? "").lastIndexOf("/"));
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return {
    id: `generated-test-failed:${behavior}:setup:${names[0]}`,
    category: "generated-test-failed",
    severity: "error",
    message: `The generated tests in ${list} could not start (${tests === 1 ? "1 test" : `${tests} tests`}), before any of the code under test ran: ${error}`,
    behavior,
    hint: `A setup problem, not a behavior the spec forbids. Check that every module the tests import resolves under vitest as it does in the project (package \`exports\` conditions, tsconfig \`paths\` and \`customConditions\`, a workspace package that must be built first), that it loads without what the project's own vitest config sets up (tsverify doesn't load it: no \`setupFiles\`, \`env\` or plugins; a module that needs an environment variable or a service as it loads fails), and that the exports \`bindings\` names can be replaced by fakes. The tests are kept in ${dir}/.`,
    ...(detail === undefined ? {} : { detail }),
  };
}

function failed(
  behavior: string,
  file: string,
  test: GeneratedTest,
  { errors, details }: Pick<TestOutcome, "errors" | "details">,
): Finding {
  const subject =
    test.kind === "replay"
      ? (test.finding ?? test.name)
      : [test.transition, test.kind === "guard" ? test.actor : test.from]
          .filter((x) => x !== undefined)
          .join(":");
  const what =
    test.kind === "replay"
      ? `The replay test "${test.name}" could not run`
      : `Generated ${test.kind} test "${test.name}" failed`;
  const finding: Finding = {
    id: `generated-test-failed:${behavior}:${test.kind}:${subject}`,
    category: "generated-test-failed",
    severity: "error",
    message: `${what}: ${firstError(errors)}`,
    behavior,
    hint: `${HINTS[test.kind]} The test is kept in ${file}.`,
  };
  if (test.transition !== undefined) finding.transition = test.transition;
  if (test.property !== undefined) finding.property = test.property;
  if (test.specAt) finding.specAt = test.specAt;
  if (test.codeAt) finding.codeAt = test.codeAt;
  const detail = details?.[0];
  if (detail !== undefined) finding.detail = detail;
  return finding;
}

const HINTS: Record<GeneratedTest["kind"], string> = {
  path: "The real code does not perform this allowed transition as the spec declares it (target state and effects).",
  forbidden:
    "The real code changes the state, or fires a declared effect, from a state the spec does not allow this transition from.",
  guard: "The real code lets an actor the spec does not allow perform this transition.",
  replay:
    "Check that the client modules in `bindings.clients` construct every client the code under test uses.",
};

function replayFinding(
  behavior: string,
  file: string,
  test: GeneratedTest,
  meta: ReplayMeta,
  source: Finding | undefined,
): Finding {
  const rest = sourceSubject(test.finding ?? test.name, behavior);
  const model = `${test.model ?? "code"}-model`;
  const against = `${test.model ?? "code"}-model counterexample`;
  const what = source?.message ?? test.property ?? test.name;
  const observed = observedText(meta);
  const base = (category: Finding["category"], severity: Finding["severity"]) => {
    const f: Finding = {
      id: `${category}:${behavior}:${rest}:${model}`,
      category,
      severity,
      message: "",
      behavior,
    };
    if (test.transition !== undefined) f.transition = test.transition;
    if (test.property !== undefined) f.property = test.property;
    if (test.specAt) f.specAt = test.specAt;
    if (test.codeAt) f.codeAt = test.codeAt;
    return f;
  };

  if (meta.verdict === "inconclusive") {
    const f = base("unanalyzable", "info");
    f.message = `Replayed the ${against} (${meta.followed ? "schedule followed" : `diverged: ${meta.divergence?.kind ?? "?"}`}), but ${test.property ?? "the property"} cannot be evaluated in code terms, so the replay is inconclusive. ${observed}`;
    f.hint = `The replay test is kept in ${file}.`;
    return f;
  }
  if (meta.verdict === "replay-disagrees") {
    const f = base("replay-disagrees", "warning");
    const why = meta.followed
      ? "the schedule was followed but the property held: a step had no effect in the code (e.g. a conditional update that matched nothing, so the code is safer than the counterexample assumes), or the replay mapping missed a call"
      : `the code left the schedule (${meta.divergence?.kind ?? "?"}) and the property held: the code is safer than the counterexample assumes`;
    f.message = `The real code does not reproduce the ${against} for: ${what} Replay: ${why}. ${observed}`;
    if (meta.divergence) f.message += `\n${meta.divergence.message}`;
    f.hint = `If the code is right, the ${test.model === "spec" ? "spec is stricter than needed (fix the spec)" : "extracted model over-approximates the code"}. The replay test is kept in ${file}.`;
    return f;
  }
  const f = base("replay-confirmed", "error");
  f.message = `Replay confirmed in the real code: ${what} ${observed}`;
  if (meta.verdict === "confirmed-divergent") {
    f.message += `\nNote: the code left the counterexample's schedule (${meta.divergence?.kind ?? "?"}) but still violated the property, so the bug is real but reached through another interleaving.`;
    if (meta.divergence) f.message += `\n${meta.divergence.message}`;
  }
  f.hint = `The replay test is kept in ${file}; it fails until the code is fixed.`;
  if (source) f.causedBy = [source.id];
  const trace: Trace | undefined = source?.trace;
  if (trace) f.trace = trace;
  return f;
}

/** `implementation-property:Order lifecycle:effect-multiplicity:stripe.refund` → `effect-multiplicity:stripe.refund`. */
function sourceSubject(id: string, behavior: string): string {
  const head = id.indexOf(":");
  const rest = head === -1 ? id : id.slice(head + 1);
  return rest.startsWith(`${behavior}:`) ? rest.slice(behavior.length + 1) : rest;
}

/** e.g. `Observed: final state refunded; stripe.refunds.create ×2.` (counts include the seeded prefix). */
function observedText(meta: ReplayMeta): string {
  const calls = Object.entries(meta.effects ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([gate, n]) => `${gate} ×${n}`);
  const status = typeof meta.status === "string" ? `final state ${meta.status}` : undefined;
  const parts = [status, calls.length > 0 ? calls.join(", ") : "no effect calls"].filter(
    (p) => p !== undefined,
  );
  return `Observed: ${parts.join("; ")}.`;
}

function firstError(errors: readonly string[]): string {
  const [first] = errors;
  if (first === undefined) return "(no error message)";
  return first.trim();
}
