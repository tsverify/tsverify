import { check } from "@tsverify/checker";
import { declaredAtomicTransitions } from "@tsverify/render";
import { type CodeOutcome, checkCode } from "../code-conformance";
import { type ExitCode, exitCodeFor, UsageError } from "../exit-codes";
import { type LoadedSpec, loadSpecs, resolveSpecFiles, selectEnforced } from "../inputs";
import type { Io } from "../io";
import { formatReport, parseFormat } from "../output/format";
import { type ProjectRef, resolveProject } from "../project-root";
import {
  allFindings,
  applyStrict,
  dedupeFindings,
  dropSpecRepeats,
  type Report,
  type SpecReport,
} from "../report";

export interface CheckCommandOptions {
  /** Raw from cac; validated by `parseFormat`. */
  format?: unknown;
  /** Raw from cac: a number, a string, or an array when the flag is repeated. */
  maxStates?: unknown;
  /** Skip code extraction and conformance. */
  specOnly?: unknown;
  /** Raw from cac: the project root for every spec, instead of discovering one per spec. */
  project?: unknown;
  /** Keep only specs with `enforced: true` (and invalid ones, which may be enforced). */
  enforcedOnly?: unknown;
  /** Report `unanalyzable` warnings as errors (`applyStrict`). */
  strict?: unknown;
}

/**
 * `tsverify check [paths…]`, per spec: validate it, model-check it, then (unless `--spec-only`)
 * extract the code model from its project, compare it with the spec and model-check it
 * (`checkCode`). Invalid specs are reported and skipped. `--enforced-only` keeps only
 * `enforced: true` specs (and invalid ones); none left is an empty run (exit 0). `--strict`
 * reports `unanalyzable` warnings as errors. Exit 0, 1 on violations, 2 on invalid input (which
 * takes precedence).
 */
export async function checkCommand(
  io: Io,
  paths: readonly string[],
  options: CheckCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format ?? "pretty");
  const { report } = await runCheck(io.cwd, paths, options);
  if (options.strict === true) applyStrict(report);
  io.stdout(formatReport(report, format, io));
  return exitCodeFor(allFindings(report));
}

/** What one `tsverify check` pipeline run produced, for `check` itself and for `tsverify view`. */
export interface CheckRun {
  report: Report;
  /** The specs that were checked (after `--enforced-only`), aligned with `report.specs`. */
  specs: LoadedSpec[];
  /** Code conformance per spec, aligned with `specs`; absent with `--spec-only`. */
  code?: CodeOutcome[];
}

/**
 * The `tsverify check` pipeline without output: validate and model-check every spec under `paths`,
 * then (unless `--spec-only`) run code conformance. Throws `UsageError` for bad options or paths.
 */
export async function runCheck(
  cwd: string,
  paths: readonly string[],
  options: Omit<CheckCommandOptions, "format">,
): Promise<CheckRun> {
  const maxStates = parseMaxStates(options.maxStates);
  const specOnly = options.specOnly === true;
  const project = await parseProject(options.project, cwd);
  const files = await resolveSpecFiles(paths, cwd);
  const loaded = await loadSpecs(files, cwd);
  const enforcedOnly = options.enforcedOnly === true ? selectEnforced(loaded) : undefined;
  const specs = enforcedOnly?.kept ?? loaded;

  const reports: SpecReport[] = specs.map(({ file, model, behavior, findings }) => {
    if (!model) return { file, behavior, findings: [...findings] };
    const result = check(model, { maxStates });
    return {
      file,
      behavior,
      ...(model.enforced && { enforced: true }),
      findings: [...findings, ...result.findings],
      stats: result.stats,
    };
  });
  let code: CodeOutcome[] | undefined;
  if (specOnly) {
    for (const r of reports) r.project = null;
  } else {
    code = await checkCode(specs, { cwd, project, maxStates });
    code.forEach((outcome, i) => {
      const r = reports[i] as SpecReport;
      r.project = outcome.project;
      r.findings.push(...outcome.findings);
      if (outcome.extract) r.extract = outcome.extract;
      if (outcome.codeStats) r.codeStats = outcome.codeStats;
      const declared = outcome.code ? declaredAtomicTransitions(outcome.code) : [];
      if (declared.length > 0) r.declaredAtomic = declared;
    });
  }
  for (const r of reports) r.findings = dropSpecRepeats(dedupeFindings(r.findings));
  const report: Report = {
    specs: reports,
    ...(specOnly ? { specOnly } : {}),
    ...(enforcedOnly && { enforcedOnly: { skipped: enforcedOnly.skipped } }),
  };
  return { report, specs, ...(code && { code }) };
}

function parseMaxStates(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(`--max-states must be a positive integer (got ${String(value)})`);
  }
  return n;
}

/**
 * `--project <dir | tsconfig>` → the project: a directory (with its `tsconfig.json`), or a
 * tsconfig file (`packages/x/tsconfig.src.json`, its directory being the root). Resolved against
 * the cwd; it must exist.
 */
export async function parseProject(value: unknown, cwd: string): Promise<ProjectRef | undefined> {
  if (value === undefined) return undefined;
  if ((typeof value !== "string" && typeof value !== "number") || value === "") {
    throw new UsageError(`--project takes one directory or tsconfig file (got ${String(value)})`);
  }
  const project = await resolveProject(String(value), cwd);
  if (project === undefined) {
    throw new UsageError(`--project: no such directory or tsconfig file: ${value}`);
  }
  return project;
}
