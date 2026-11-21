import type { Finding } from "@tsv/ir";
import { INPUT_ERROR_CATEGORIES } from "@tsv/ir";

/** The exit code contract (doc 3, D4). CI decides policy from these; the tool never does. */
export const ExitCode = {
  /** No error-severity findings. Warnings and info never fail a run. */
  Ok: 0,
  /** Error-severity findings that are behavior bugs or conformance mismatches. */
  Violations: 1,
  /** Invalid input: a spec that doesn't parse or validate, a broken link, or bad CLI usage. */
  InvalidInput: 2,
  /** An unexpected exception inside the tool. */
  Internal: 3,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Bad CLI usage (unknown command, bad flag value…): reported on stderr, exit code 2. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Invalid input (2) takes precedence over violations (1). */
export function exitCodeFor(findings: readonly Finding[]): ExitCode {
  let code: ExitCode = ExitCode.Ok;
  for (const f of findings) {
    if (f.severity !== "error") continue;
    if (INPUT_ERROR_CATEGORIES.has(f.category)) return ExitCode.InvalidInput;
    code = ExitCode.Violations;
  }
  return code;
}
