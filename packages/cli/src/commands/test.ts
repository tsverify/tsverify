import { join } from "node:path";
import { check } from "@tsverify/checker";
import { type Finding, INPUT_ERROR_CATEGORIES } from "@tsverify/ir";
import { type GeneratedTest, generate } from "@tsverify/testgen";
import { checkCode } from "../code-conformance";
import { type ExitCode, exitCodeFor } from "../exit-codes";
import { outDirs, writeGenerated } from "../generated-dir";
import { loadSpecs, resolveSpecFiles, selectEnforced } from "../inputs";
import type { Io } from "../io";
import { rebaseFile, rebaseLocations } from "../locations";
import { formatReport, parseFormat } from "../output/format";
import { allFindings, dedupeFindings, type Report, type SpecReport } from "../report";
import { testFindings } from "../test-findings";
import { runGeneratedTests } from "../test-run";
import { parseProject } from "./check";

export interface TestCommandOptions {
  /** Raw from cac; validated by `parseFormat`. */
  format?: unknown;
  /** Raw from cac: the project root for every spec, instead of discovering one per spec. */
  project?: unknown;
  /** Keep only specs with `enforced: true` (and invalid ones, which may be enforced). */
  enforcedOnly?: unknown;
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
 * `tsv test [paths…]`: run the `tsv check` pipeline (spec → checker → extractor → conformance →
 * checker on the code model), generate vitest files per spec into
 * `<project>/.tsv/generated/<spec-slug>/` (the directory is deleted first; the files are kept
 * afterwards), run them with vitest in-process, once per project root, and report the results
 * as findings: `generated-test-failed`, `replay-confirmed`, `replay-disagrees`, plus `info`
 * findings for what could not be generated. Static findings are left to `tsv check`; only input
 * errors (invalid spec, broken link) are reported as well, since they make the run invalid.
 * Exit 0, 1 on any error finding, 2 on invalid input (which takes precedence).
 */
export async function testCommand(
  io: Io,
  paths: readonly string[],
  options: TestCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format ?? "pretty");
  const project = await parseProject(options.project, io.cwd);
  const cwd = io.cwd;
  const files = await resolveSpecFiles(paths, cwd);
  const loaded = await loadSpecs(files, cwd);
  const enforcedOnly = options.enforcedOnly === true ? selectEnforced(loaded) : undefined;
  const specs = enforcedOnly?.kept ?? loaded;

  const reports: SpecReport[] = specs.map(({ file, model, behavior, findings }) => ({
    file,
    behavior,
    ...(model?.enforced && { enforced: true }),
    findings: findings.filter(isInputError),
  }));
  const specChecks = specs.map((s) => (s.model ? check(s.model).findings : []));
  const outcomes = await checkCode(specs, { cwd, project });

  // Generate and write, grouped by project root (one vitest run each).
  const roots = new Map<string, number[]>();
  outcomes.forEach((outcome, i) => {
    const report = reports[i] as SpecReport;
    report.project = outcome.project;
    report.findings.push(...outcome.findings.filter(isInputError));
    if (outcome.root === undefined || !outcome.spec || !outcome.code) return;
    roots.set(outcome.root, [...(roots.get(outcome.root) ?? []), i]);
  });

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
      await writeGenerated(root, outDir, generated.files);
      report.findings.push(...rebaseLocations(generated.skipped, root, cwd));
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
    const run = await runGeneratedTests(
      root,
      runnable.map((j) => `${j.outDir}/**/*.test.ts`),
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
  io.stdout(formatReport(report, format, io));
  return exitCodeFor(allFindings(report));
}

function isInputError(f: Finding): boolean {
  return INPUT_ERROR_CATEGORIES.has(f.category);
}
