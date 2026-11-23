import { join } from "node:path";
import { check } from "@tsverify/checker";
import { type BehaviorModel, type Finding, INPUT_ERROR_CATEGORIES } from "@tsverify/ir";
import { type GeneratedTest, type GenerateResult, generate } from "@tsverify/testgen";
import { checkCode } from "../code-conformance";
import { ExitCode, exitCodeFor } from "../exit-codes";
import { outDirs, removeGenerated, writeGenerated } from "../generated-dir";
import { loadSpecs, resolveSpecFiles, selectEnforced } from "../inputs";
import type { Io } from "../io";
import { rebaseFile, rebaseLocations } from "../locations";
import { formatReport, parseFormat } from "../output/format";
import {
  allFindings,
  applyStrict,
  dedupeFindings,
  isStrictPromoted,
  type Report,
  type SpecReport,
} from "../report";
import { testFindings } from "../test-findings";
import { runGeneratedTests } from "../test-run";
import { findVitest, type ResolvedVitest } from "../vitest-resolve";
import { parseMaxStates, parseProject } from "./check";

export interface TestCommandOptions {
  /** Raw from cac; validated by `parseFormat`. */
  format?: unknown;
  /** Raw from cac: the project root for every spec, instead of discovering one per spec. */
  project?: unknown;
  /** Keep only specs with `enforced: true` (and invalid ones, which may be enforced). */
  enforcedOnly?: unknown;
  /** Also report the static `unanalyzable` warnings, as errors (`applyStrict`). */
  strict?: unknown;
  /** Raw from cac: the checker's state limit per model, as for `tsverify check`. */
  maxStates?: unknown;
}

/** One spec whose tests were generated, waiting for its project's vitest run. */
interface Job {
  report: SpecReport;
  behavior: string;
  outDir: string;
  tests: GeneratedTest[];
  sources: Map<string, Finding>;
}

/**
 * `tsverify test [paths…]`: run the `tsverify check` pipeline (spec → checker → extractor → conformance →
 * checker on the code model), generate vitest files per spec into
 * `<project>/.tsverify/generated/<spec-slug>/` (the directory is deleted first; the files are kept
 * afterwards; a spec with no test gets no directory), run them with vitest in-process, once per
 * project root, and report the results as findings: `generated-test-failed`, `replay-confirmed`,
 * `replay-disagrees`, plus `info` findings for what could not be generated. Static findings are
 * left to `tsverify check`; only input errors (invalid spec, broken link) are reported as well,
 * since they make the run invalid. `--strict` also reports the static `unanalyzable` warnings
 * (what the generated tests may not cover), as errors, and so is every transition with an `impl`
 * that got no test at all, and a spec with such transitions that got none (`strictUntested`).
 * Exit 0, 1 on any error finding, 2 on invalid input (which takes precedence).
 * vitest is an optional peer dependency (`vitest-resolve.ts`): when a project with tests to run
 * has no usable vitest, the command says so on stderr, before generating anything, and exits 2.
 */
export async function testCommand(
  io: Io,
  paths: readonly string[],
  options: TestCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format ?? "pretty");
  const maxStates = parseMaxStates(options.maxStates);
  const strict = options.strict === true;
  const kept = (f: Finding) => isInputError(f) || (strict && isStrictPromoted(f));
  const project = await parseProject(options.project, io.cwd);
  const cwd = io.cwd;
  const files = await resolveSpecFiles(paths, cwd);
  const loaded = await loadSpecs(files, cwd);
  const enforcedOnly = options.enforcedOnly === true ? selectEnforced(loaded) : undefined;
  const specs = enforcedOnly?.kept ?? loaded;

  const specChecks = specs.map((s) => (s.model ? check(s.model, { maxStates }).findings : []));
  const reports: SpecReport[] = specs.map(({ file, model, behavior, findings }, i) => ({
    file,
    behavior,
    ...(model?.enforced && { enforced: true }),
    findings: [...findings, ...(specChecks[i] ?? [])].filter(kept),
  }));
  const outcomes = await checkCode(specs, { cwd, project, maxStates });

  // `--strict`: not-generated findings raised to errors (`strictUntested`).
  let untested = 0;
  // Generate and write, grouped by project root (one vitest run each).
  const roots = new Map<string, number[]>();
  outcomes.forEach((outcome, i) => {
    const report = reports[i] as SpecReport;
    report.project = outcome.project;
    report.findings.push(...outcome.findings.filter(kept));
    if (outcome.root === undefined || !outcome.spec || !outcome.code) return;
    roots.set(outcome.root, [...(roots.get(outcome.root) ?? []), i]);
  });

  // vitest is an optional peer dependency: without a usable one, nothing is generated or run.
  const runners = new Map<string, ResolvedVitest>();
  for (const root of roots.keys()) {
    const found = findVitest(root);
    if (!found.ok) {
      io.stderr(found.message);
      return ExitCode.InvalidInput;
    }
    runners.set(root, found.vitest);
  }

  for (const [root, members] of roots) {
    const dirs = outDirs(members.map((i) => outcomes[i]?.spec?.name ?? ""));
    const jobs: Job[] = [];
    for (const [k, i] of members.entries()) {
      const outcome = outcomes[i];
      const report = reports[i] as SpecReport;
      const outDir = dirs[k] as string;
      if (!outcome?.spec || !outcome.code) continue;
      const sourceFindings = rebaseLocations(
        [...(specChecks[i] ?? []), ...outcome.findings],
        cwd,
        root,
      );
      const generated = generate({
        spec: { ...outcome.spec, file: rebaseFile(specs[i]?.file ?? "", cwd, root) },
        code: outcome.code,
        findings: sourceFindings,
        outDir,
      });
      const skipped = strict ? strictUntested(outcome.spec, generated) : generated.skipped;
      report.findings.push(...rebaseLocations(skipped, root, cwd));
      untested += skipped.filter(
        (f) => f.category === "not-generated" && f.severity === "error",
      ).length;
      // Nothing to run: no directory (and none left over from an earlier run).
      if (generated.tests.length === 0) {
        await removeGenerated(root, outDir);
        continue;
      }
      await writeGenerated(root, outDir, generated.files);
      report.generated = {
        dir: rebaseFile(join(root, outDir), cwd, cwd),
        tests: { total: generated.tests.length, passed: 0, failed: 0, missing: 0 },
      };
      jobs.push({
        report,
        behavior: outcome.spec.name,
        outDir,
        tests: generated.tests,
        sources: new Map(sourceFindings.map((f) => [f.id, f])),
      });
    }

    const runnable = jobs.filter((j) => j.tests.length > 0);
    if (runnable.length === 0) continue;
    const conditions = members.map((i) => outcomes[i]?.customConditions).find((c) => c);
    const run = await runGeneratedTests(
      root,
      runnable.map((j) => `${j.outDir}/**/*.test.ts`),
      runners.get(root) as ResolvedVitest,
      conditions === undefined ? {} : { conditions },
    );
    for (const job of runnable) {
      const mapped = testFindings({
        behavior: job.behavior,
        outDir: job.outDir,
        tests: job.tests,
        outcomes: run.outcomes,
        sources: job.sources,
      });
      job.report.findings.push(...rebaseLocations(mapped.findings, root, cwd));
      if (job.report.generated) job.report.generated.tests = mapped.counts;
    }
    const [first] = runnable;
    run.unhandled.forEach((message, n) => {
      first?.report.findings.push({
        id: `generated-test-failed:${first.behavior}:unhandled:${n + 1}`,
        category: "generated-test-failed",
        severity: "error",
        message: `vitest reported an error outside any generated test: ${message}`,
        behavior: first.behavior,
      });
    });
  }

  for (const r of reports) r.findings = dedupeFindings(r.findings);
  const report: Report = {
    specs: reports,
    command: "test",
    ...(enforcedOnly && { enforcedOnly: { skipped: enforcedOnly.skipped } }),
  };
  if (strict) applyStrict(report, untested);
  io.stdout(formatReport(report, format, io));
  return exitCodeFor(allFindings(report));
}

/**
 * `--strict`: `generated.skipped`, where a transition with an `impl` that got no test at all is
 * an error, and so is a spec that got no test although it has such transitions. The `info`
 * finding that explains it is raised to an error (the transition's own `not-generated`, or the
 * spec's, such as "no `fixtures`"); with none, an error `not-generated:<behavior>:strict[:<t>]`
 * is added. A test kind that could not be generated (a guard test, a replay) stays `info`: the
 * transition is still run.
 */
export function strictUntested(spec: BehaviorModel, generated: GenerateResult): Finding[] {
  const linked = spec.transitions.filter((t) => t.impl !== undefined);
  if (linked.length === 0) return generated.skipped;
  const tested = new Set(generated.tests.map((t) => t.transition));
  const raise = new Set<string>();
  const added: Finding[] = [];
  const base = (id: string): Finding => ({
    id,
    category: "not-generated",
    severity: "error",
    message: "",
    behavior: spec.name,
  });
  const specWide = generated.skipped.filter(
    (f) => f.transition === undefined && /^not-generated:.*:testgen:[^:]+$/.test(f.id),
  );
  if (generated.tests.length === 0) {
    if (specWide.length > 0) for (const f of specWide) raise.add(f.id);
    else {
      added.push({
        ...base(`not-generated:${spec.name}:strict`),
        message: `tsverify test generated no tests for ${spec.name}, although ${linked.length === 1 ? "1 transition has" : `${linked.length} transitions have`} an \`impl\`: none of its code was run.`,
        hint: "Read the other not-generated findings for why, and fix what they name (fixtures, storage, the writes tsverify can't read).",
      });
    }
  }
  for (const t of linked) {
    if (tested.has(t.name)) continue;
    const own = generated.skipped.find(
      (f) => f.transition === t.name && f.id === `not-generated:${spec.name}:testgen:${t.name}`,
    );
    if (own) {
      raise.add(own.id);
      continue;
    }
    added.push({
      ...base(`not-generated:${spec.name}:strict:${t.name}`),
      message: `${t.name}: tsverify test generated no test for it, so its impl (${t.impl?.symbol}) was not run.`,
      hint: "Read the spec-wide not-generated finding for why, and fix what it names.",
      transition: t.name,
      ...(specWide.length > 0 ? { causedBy: specWide.map((f) => f.id) } : {}),
      ...(t.at === undefined ? {} : { specAt: t.at }),
    });
  }
  return [
    ...generated.skipped.map((f) => (raise.has(f.id) ? { ...f, severity: "error" as const } : f)),
    ...added,
  ];
}

function isInputError(f: Finding): boolean {
  return INPUT_ERROR_CATEGORIES.has(f.category);
}
