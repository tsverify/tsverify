import { UsageError } from "../exit-codes";
import type { Io } from "../io";
import type { Report } from "../report";
import { formatJson } from "./json";
import { formatPretty } from "./pretty";
import { formatSarif } from "./sarif";

export const OUTPUT_FORMATS = ["pretty", "json", "sarif"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Validates a raw `--format` value from cac. */
export function parseFormat(value: unknown): OutputFormat {
  const format = OUTPUT_FORMATS.find((f) => f === value);
  if (format === undefined) {
    throw new UsageError(
      `--format must be one of ${OUTPUT_FORMATS.join(", ")} (got ${String(value)})`,
    );
  }
  return format;
}

/** The whole stdout of `validate` / `check` / `test`. */
export function formatReport(report: Report, format: OutputFormat, io: Io): string {
  switch (format) {
    case "json":
      return formatJson(report);
    case "sarif":
      return formatSarif(report, io.cwd);
    case "pretty":
      return formatPretty(report, io);
  }
}
