import { type ExitCode, exitCodeFor } from "../exit-codes";
import { loadSpecs, resolveSpecFiles } from "../inputs";
import type { Io } from "../io";
import { formatPretty } from "../output/pretty";
import { allFindings, type Report } from "../report";

/** `tsv validate [paths…]`: parse and validate specs. Exit 0, or 2 on any invalid spec. */
export async function validateCommand(io: Io, paths: readonly string[]): Promise<ExitCode> {
  const files = await resolveSpecFiles(paths, io.cwd);
  const specs = await loadSpecs(files, io.cwd);
  const report: Report = {
    specs: specs.map(({ file, behavior, findings }) => ({ file, behavior, findings })),
  };
  io.stdout(formatPretty(report, io));
  return exitCodeFor(allFindings(report));
}
