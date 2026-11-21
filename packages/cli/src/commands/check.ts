import { check } from "@tsv/checker";
import { type ExitCode, exitCodeFor, UsageError } from "../exit-codes";
import { loadSpecs, resolveSpecFiles } from "../inputs";
import type { Io } from "../io";
import { formatReport, parseFormat } from "../output/format";
import { allFindings, type Report, type SpecReport } from "../report";

export interface CheckCommandOptions {
  /** Raw from cac; validated by `parseFormat`. */
  format?: unknown;
  /** Raw from cac: a number, a string, or an array when the flag is repeated. */
  maxStates?: unknown;
  /** Accepted for forward compatibility; every check is spec-only until the extractor lands. */
  specOnly?: unknown;
}

export const SPEC_ONLY_NOTE = "note: spec-only check; code conformance isn't available yet";

/**
 * `tsv check [paths…]`: validate, then model-check every valid spec. Invalid specs are reported
 * and skipped. Exit 0, 1 on violations, 2 on invalid input (which takes precedence).
 */
export async function checkCommand(
  io: Io,
  paths: readonly string[],
  options: CheckCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format ?? "pretty");
  const maxStates = parseMaxStates(options.maxStates);
  const files = await resolveSpecFiles(paths, io.cwd);
  const specs = await loadSpecs(files, io.cwd);

  const reports: SpecReport[] = specs.map(({ file, model, behavior, findings }) => {
    if (!model) return { file, behavior, findings };
    const result = check(model, { maxStates });
    return { file, behavior, findings: [...findings, ...result.findings], stats: result.stats };
  });
  const report: Report = { specs: reports, notes: [SPEC_ONLY_NOTE] };

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
