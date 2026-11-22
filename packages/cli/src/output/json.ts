import type { CheckStats } from "@tsverify/checker";
import type { ExtractStats } from "@tsverify/extractor";
import type { Finding } from "@tsverify/ir";
import { allFindings, countSeverity, type Report } from "../report";
import type { TestCounts } from "../test-findings";

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
  /** Present (and `true`) with `--strict`: `unanalyzable` warnings are reported as errors. */
  strict?: true;
}

export interface JsonSpec {
  file: string;
  /** null when the file is too broken to name its behavior. */
  behavior: string | null;
  /** Present (and `true`) only when the spec says `enforced: true`. */
  enforced?: true;
  /** Present when the spec was model-checked. */
  stats?: JsonStats;
  /**
   * `check` only: the spec's project root relative to the cwd (`.` for the cwd); null with
   * `--spec-only` or when no tsconfig.json was found.
   */
  project?: string | null;
  /** Present when the code model extracted from the project was model-checked. */
  codeStats?: JsonStats;
  /** Present when the spec's project was extracted (the same for every spec of a project). */
  extract?: JsonExtractStats;
  /** `test` only: the generated directory (relative to the cwd) and the test counts. */
  generated?: { dir: string; tests: TestCounts };
}

/** `CheckStats` without `durationMs`, which would make the document non-deterministic. */
export type JsonStats = Omit<CheckStats, "durationMs">;

/** `ExtractStats` without `durationMs`. */
export type JsonExtractStats = Omit<ExtractStats, "durationMs">;

export function toJsonReport(report: Report): JsonReport {
  const findings = allFindings(report);
  return {
    version: 1,
    findings,
    specs: report.specs.map((s) => {
      const { file, behavior, enforced, stats, project, codeStats, extract, generated } = s;
      const spec: JsonSpec = { file, behavior: behavior ?? null };
      if (enforced) spec.enforced = true;
      if (stats) spec.stats = withoutDuration(stats);
      if (project !== undefined) spec.project = project;
      if (codeStats) spec.codeStats = withoutDuration(codeStats);
      if (extract) spec.extract = withoutDuration(extract);
      if (generated) spec.generated = generated;
      return spec;
    }),
    summary: {
      errors: countSeverity(findings, "error"),
      warnings: countSeverity(findings, "warning"),
    },
    ...(report.strict && { strict: true as const }),
  };
}

function withoutDuration<T extends { durationMs: number }>(stats: T): Omit<T, "durationMs"> {
  const { durationMs: _, ...rest } = stats;
  return rest;
}

export function formatJson(report: Report): string {
  return `${JSON.stringify(toJsonReport(report), null, 2)}\n`;
}
