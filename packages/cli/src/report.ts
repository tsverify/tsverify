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
  /**
   * `test` only: where the spec's tests were generated (relative to the cwd) and how they ran.
   * Absent when no test was generated (no directory is written).
   */
  generated?: { dir: string; tests: TestCounts };
  /**
   * `check` only: transitions that are atomic only because the spec declares a function atomic
   * (`bindings.storage.atomic`, which tsverify does not check inside), with that function. Absent
   * when there are none.
   */
  declaredAtomic?: { transition: string; by: string }[];
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
  /**
   * `--strict`: how many `unanalyzable` warnings were reported as errors (`applyStrict`), and
   * (`test`) how many `not-generated` findings were (`strictUntested`).
   */
  strict?: { promoted: number; untested?: number };
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

/**
 * Drops an `implementation-property` finding that repeats a `spec-property` finding of the same
 * spec: same message, same counterexample. The code model then only inherits a problem of the
 * spec itself (a skeleton spec with no transitions is stuck in its initial state either way), and
 * the spec's finding is the one to fix.
 */
export function dropSpecRepeats(findings: readonly Finding[]): Finding[] {
  // The traces differ only in which model they come from.
  const key = (f: Finding) =>
    `${f.message}\u0000${JSON.stringify(f.trace ? { ...f.trace, model: "" } : null)}`;
  const spec = new Set(findings.filter((f) => f.category === "spec-property").map(key));
  return findings.filter((f) => f.category !== "implementation-property" || !spec.has(key(f)));
}

export function countSeverity(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((f) => f.severity === severity).length;
}

/** Whether `--strict` reports `f` as an error: an `unanalyzable` warning. */
export function isStrictPromoted(f: Finding): boolean {
  return f.category === "unanalyzable" && f.severity === "warning";
}

/**
 * `--strict`: every `unanalyzable` warning (code or a model tsverify could not fully analyze, so a
 * finding may be hiding there) becomes an error, so the run exits 1. `unanalyzable` infos (a
 * transition without `impl`, a choice the spec states) stay infos. Sets `report.strict`, with
 * `untested`: the `not-generated` findings `tsverify test --strict` already raised.
 */
export function applyStrict(report: Report, untested = 0): void {
  let promoted = 0;
  for (const spec of report.specs) {
    spec.findings = spec.findings.map((f) => {
      if (!isStrictPromoted(f)) return f;
      promoted++;
      return { ...f, severity: "error" };
    });
  }
  report.strict = { promoted, ...(untested > 0 ? { untested } : {}) };
}
