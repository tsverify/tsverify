/**
 * Vitest results of the generated tests → findings (doc 3 Part C, "How the outcomes combine"):
 *
 * | Generated test                          | Finding                                   |
 * |-----------------------------------------|-------------------------------------------|
 * | path / forbidden / guard test fails     | `generated-test-failed` (error), at the impl's write |
 * | replay verdict `confirmed`              | `replay-confirmed` (error)                |
 * | replay verdict `confirmed-divergent`    | `replay-confirmed` (error), with a note on the divergence |
 * | replay verdict `replay-disagrees`       | `replay-disagrees` (warning)              |
 * | replay verdict `inconclusive`           | `unanalyzable` (info)                     |
 * | replay test fails without a verdict     | `generated-test-failed` (error): it could not run |
 *
 * Replay verdicts come from `task.meta.tsvReplay`, which every generated replay test sets
 * before its assertion (see packages/testgen/README.md). A `replay-confirmed` finding has
 * `causedBy` the `tsv check` finding it replayed, when that finding is in `sources`.
 */
import type { Finding, Trace } from "@tsv/ir";
import type { GeneratedTest } from "@tsv/testgen";
import type { TestOutcome } from "./test-run";

/** What a generated replay test stores in `task.meta.tsvReplay`. */
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
  /** Generated directory relative to the project root (e.g. `.tsv/generated/order-lifecycle`). */
  outDir: string;
  tests: readonly GeneratedTest[];
  outcomes: readonly TestOutcome[];
  /** The `tsv check` findings the replays came from, by id. */
  sources: ReadonlyMap<string, Finding>;
}

export function testFindings(input: MapInput): { findings: Finding[]; counts: TestCounts } {
  const { behavior, outDir, tests, outcomes, sources } = input;
  const byKey = new Map(outcomes.map((o) => [`${o.file}\n${o.name}`, o]));
  const counts: TestCounts = { total: tests.length, passed: 0, failed: 0, missing: 0 };
  const findings: Finding[] = [];
  for (const test of tests) {
    const file = `${outDir}/${test.file}`;
    const outcome = byKey.get(`${file}\n${test.name}`) ?? byKey.get(`${file}\n`);
    if (outcome === undefined) {
      counts.missing++;
      findings.push(failed(behavior, file, test, ["vitest did not run this test"]));
      continue;
    }
    if (outcome.state === "passed") counts.passed++;
    else counts.failed++;

    if (test.kind !== "replay") {
      if (outcome.state !== "passed") findings.push(failed(behavior, file, test, outcome.errors));
      continue;
    }
    const meta = outcome.meta.tsvReplay as ReplayMeta | undefined;
    const source = test.finding === undefined ? undefined : sources.get(test.finding);
    if (meta === undefined) {
      if (outcome.state !== "passed") findings.push(failed(behavior, file, test, outcome.errors));
      continue;
    }
    findings.push(replayFinding(behavior, file, test, meta, source));
  }
  return { findings, counts };
}

function failed(
  behavior: string,
  file: string,
  test: GeneratedTest,
  errors: readonly string[],
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
