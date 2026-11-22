import { check } from "@tsv/checker";
import { checkCode } from "../code-conformance";
import { type ExitCode, exitCodeFor, UsageError } from "../exit-codes";
import { loadSpecs, resolveSpecFiles } from "../inputs";
import type { Io } from "../io";
import { formatReport, parseFormat } from "../output/format";
import { resolveProjectDir } from "../project-root";
import { allFindings, dedupeFindings, type Report, type SpecReport } from "../report";

export interface CheckCommandOptions {
  /** Raw from cac; validated by `parseFormat`. */
  format?: unknown;
  /** Raw from cac: a number, a string, or an array when the flag is repeated. */
  maxStates?: unknown;
  /** Skip code extraction and conformance. */
  specOnly?: unknown;
  /** Raw from cac: the project root for every spec, instead of discovering one per spec. */
  project?: unknown;
}

/**
 * `tsv check [paths…]`, per spec: validate it, model-check it, then (unless `--spec-only`)
 * extract the code model from its project, compare it with the spec and model-check it
 * (`checkCode`). Invalid specs are reported and skipped. Exit 0, 1 on violations, 2 on invalid
 * input (which takes precedence).
 */
export async function checkCommand(
  io: Io,
  paths: readonly string[],
  options: CheckCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format ?? "pretty");
  const maxStates = parseMaxStates(options.maxStates);
  const specOnly = options.specOnly === true;
  const project = await parseProject(options.project, io.cwd);
  const files = await resolveSpecFiles(paths, io.cwd);
  const specs = await loadSpecs(files, io.cwd);

  const reports: SpecReport[] = specs.map(({ file, model, behavior, findings }) => {
    if (!model) return { file, behavior, findings: [...findings] };
    const result = check(model, { maxStates });
    return { file, behavior, findings: [...findings, ...result.findings], stats: result.stats };
  });
  if (specOnly) {
    for (const r of reports) r.project = null;
  } else {
    const outcomes = await checkCode(specs, { cwd: io.cwd, project, maxStates });
    outcomes.forEach((code, i) => {
      const r = reports[i] as SpecReport;
      r.project = code.project;
      r.findings.push(...code.findings);
      if (code.extract) r.extract = code.extract;
      if (code.codeStats) r.codeStats = code.codeStats;
    });
  }
  for (const r of reports) r.findings = dedupeFindings(r.findings);
  const report: Report = { specs: reports, ...(specOnly ? { specOnly } : {}) };

  io.stdout(formatReport(report, format, io));
  return exitCodeFor(allFindings(report));
}

function parseMaxStates(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(`--max-states must be a positive integer (got ${String(value)})`);
  }
  return n;
}

/** `--project <dir>` → an absolute directory. Resolved against the cwd; it must exist. */
export async function parseProject(value: unknown, cwd: string): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new UsageError(`--project takes one directory (got ${String(value)})`);
  }
  const dir = await resolveProjectDir(String(value), cwd);
  if (dir === undefined) throw new UsageError(`--project: no such directory: ${value}`);
  return dir;
}
