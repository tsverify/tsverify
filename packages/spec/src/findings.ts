import type { Finding, SourceLocation } from "@tsv/ir";

export interface SpecIssue {
  severity: "error" | "warning";
  message: string;
  at: SourceLocation;
  transition?: string;
  hint?: string;
}

/**
 * Collects `invalid-spec` findings for one file. `finish()` returns them sorted by position (then
 * message) with stable ids `invalid-spec:<file>:<line>:<column>` (`#2`, `#3`… on collisions).
 */
export class FindingCollector {
  private readonly issues: SpecIssue[] = [];
  behavior: string | undefined;

  constructor(private readonly file: string) {}

  error(at: SourceLocation, message: string, extra?: Pick<SpecIssue, "transition" | "hint">) {
    this.issues.push({ severity: "error", message, at, ...extra });
  }

  warning(at: SourceLocation, message: string, extra?: Pick<SpecIssue, "transition" | "hint">) {
    this.issues.push({ severity: "warning", message, at, ...extra });
  }

  hasErrors(): boolean {
    return this.issues.some((i) => i.severity === "error");
  }

  finish(): Finding[] {
    const sorted = [...this.issues].sort(
      (a, b) =>
        a.at.line - b.at.line ||
        a.at.column - b.at.column ||
        compare(a.severity, b.severity) ||
        compare(a.message, b.message),
    );
    const seen = new Map<string, number>();
    return sorted.map((issue) => {
      const base = `invalid-spec:${this.file}:${issue.at.line}:${issue.at.column}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const finding: Finding = {
        id: n === 1 ? base : `${base}#${n}`,
        category: "invalid-spec",
        severity: issue.severity,
        message: issue.message,
      };
      if (this.behavior !== undefined) finding.behavior = this.behavior;
      if (issue.transition !== undefined) finding.transition = issue.transition;
      finding.specAt = issue.at;
      if (issue.hint !== undefined) finding.hint = issue.hint;
      return finding;
    });
  }
}

/** Locale-independent string comparison, for deterministic ordering. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `"refundd"` → `"refunded"` when a candidate is within a small edit distance. */
export function suggest(word: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  // Accept up to 1 edit for short words, 2 for medium, 3 for long ones.
  let bestDistance = (word.length <= 3 ? 1 : word.length <= 7 ? 2 : 3) + 1;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best === word ? undefined : best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** `a, b, c` — truncated with `…` after `max` items. */
export function list(items: readonly string[], max = 12): string {
  if (items.length === 0) return "none";
  return items.length > max ? `${items.slice(0, max).join(", ")}, …` : items.join(", ");
}
