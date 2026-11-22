import type { CheckStats } from "@tsverify/checker";
import type { ExtractStats } from "@tsverify/extractor";
import type { Finding, Severity } from "@tsverify/ir";
import type { TestCounts } from "./test-findings";

/** One spec file's outcome: what `validate` and `check` hand to the output formats. */
export interface SpecReport {
  file: string;
  behavior?: string;
  /** The spec says `enforced: true` (see `BehaviorModel.enforced`). */
  enforced?: boolean;
  /**
   * In pipeline order: spec findings, spec checker findings, then (code conformance) extractor
   * findings, conformance mismatches and code-model checker findings. Deduplicated by `id`.
   */
  findings: Finding[];
  /** Present when the spec was model-checked. */
  stats?: CheckStats;
  /**
   * `check` only: the spec's project root, relative to the cwd (`.` for the cwd itself); `null`
   * with `--spec-only` or when no `tsconfig.json` was found.
   */
  project?: string | null;
  /** Present when the extracted code model was model-checked. */
  codeStats?: CheckStats;
  /** Present when the spec's project was extracted. Shared by every spec of that project. */
  extract?: ExtractStats;
  /** `test` only: where the spec's tests were generated (relative to the cwd) and how they ran. */
  generated?: { dir: string; tests: TestCounts };
}

export interface Report {
  /** In file order. */
  specs: SpecReport[];
  /** `check --spec-only`: code conformance was skipped on purpose. */
  specOnly?: boolean;
  /** `test`: the findings are generated-test results only (static ones come from `check`). */
  command?: "test";
  /** `--enforced-only`: how many specs were left out because they are not `enforced: true`. */
  enforcedOnly?: { skipped: number };
}

export function allFindings(report: Report): Finding[] {
  return report.specs.flatMap((s) => s.findings);
}

/** Drops findings whose `id` was already seen, keeping the first; order is otherwise kept. */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

export function countSeverity(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((f) => f.severity === severity).length;
}
