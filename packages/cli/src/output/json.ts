import type { CheckStats } from "@tsv/checker";
import type { Finding } from "@tsv/ir";
import { allFindings, countSeverity, type Report } from "../report";

/**
 * The `--format json` document. Its shape is a contract for CI and agents: bump `version` on any
 * breaking change. Output is deterministic (no timings), so it can be diffed and snapshotted.
 */
export interface JsonReport {
  version: 1;
  /** Every finding, spec by spec in file order; locations are relative to the cwd. */
  findings: Finding[];
  specs: JsonSpec[];
  summary: { errors: number; warnings: number };
}

export interface JsonSpec {
  file: string;
  /** null when the file is too broken to name its behavior. */
  behavior: string | null;
  /** Present when the spec was model-checked. */
  stats?: JsonStats;
}

/** `CheckStats` without `durationMs`, which would make the document non-deterministic. */
export type JsonStats = Omit<CheckStats, "durationMs">;

export function toJsonReport(report: Report): JsonReport {
  const findings = allFindings(report);
  return {
    version: 1,
    findings,
    specs: report.specs.map(({ file, behavior, stats }) => {
      const spec: JsonSpec = { file, behavior: behavior ?? null };
      if (stats) {
        const { durationMs: _, ...rest } = stats;
        spec.stats = rest;
      }
      return spec;
    }),
    summary: {
      errors: countSeverity(findings, "error"),
      warnings: countSeverity(findings, "warning"),
    },
  };
}

export function formatJson(report: Report): string {
  return `${JSON.stringify(toJsonReport(report), null, 2)}\n`;
}
