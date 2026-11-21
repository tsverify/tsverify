import type { CheckStats } from "@tsv/checker";
import type { Finding, Severity } from "@tsv/ir";

/** One spec file's outcome: what `validate` and `check` hand to the output formats. */
export interface SpecReport {
  file: string;
  behavior?: string;
  /** Spec findings, then checker findings. */
  findings: Finding[];
  /** Present when the spec was model-checked. */
  stats?: CheckStats;
}

export interface Report {
  /** In file order. */
  specs: SpecReport[];
  /** Dim lines shown before the findings in pretty output; never part of JSON. */
  notes?: string[];
}

export function allFindings(report: Report): Finding[] {
  return report.specs.flatMap((s) => s.findings);
}

export function countSeverity(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((f) => f.severity === severity).length;
}
