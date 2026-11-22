import { type ExitCode, exitCodeFor } from "../exit-codes";
import { loadSpecs, resolveSpecFiles } from "../inputs";
import type { Io } from "../io";
import { formatReport, parseFormat } from "../output/format";
import { allFindings, type Report } from "../report";

export interface ValidateCommandOptions {
  /** Raw from cac; validated by `parseFormat`. */
  format?: unknown;
}

/** `tsv validate [paths…]`: parse and validate specs. Exit 0, or 2 on any invalid spec. */
export async function validateCommand(
  io: Io,
  paths: readonly string[],
  options: ValidateCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format ?? "pretty");
  const files = await resolveSpecFiles(paths, io.cwd);
  const specs = await loadSpecs(files, io.cwd);
  const report: Report = {
    specs: specs.map(({ file, model, behavior, findings }) => ({
      file,
      behavior,
      ...(model?.enforced && { enforced: true }),
      findings,
    })),
  };
  io.stdout(formatReport(report, format, io));
  return exitCodeFor(allFindings(report));
}
