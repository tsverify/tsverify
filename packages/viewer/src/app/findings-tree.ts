import { compareStrings, type Finding, type Severity, type SourceLocation } from "@tsverify/ir";

/** A finding and the findings that are its consequences (`causedBy`), recursively. */
export interface FindingNode {
  finding: Finding;
  consequences: FindingNode[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Findings grouped by root cause, like `tsv check`'s pretty output (`formatFindings` with
 * `groupCauses`): ordered by severity, location and id, with every finding whose `causedBy`
 * names another finding of the list nested under the first such cause in that order. A link
 * that would close a cycle is ignored, so each finding appears exactly once.
 */
export function groupByRootCause(findings: readonly Finding[]): FindingNode[] {
  const sorted = [...findings].sort(compareFindings);
  const position = new Map<string, number>();
  sorted.forEach((f, i) => {
    if (!position.has(f.id)) position.set(f.id, i);
  });

  const parent = new Map<number, number>();
  sorted.forEach((f, i) => {
    const causes = (f.causedBy ?? [])
      .map((id) => position.get(id))
      .filter((p): p is number => p !== undefined && p !== i);
    if (causes.length === 0) return;
    const cause = Math.min(...causes);
    for (let p: number | undefined = cause; p !== undefined; p = parent.get(p)) {
      if (p === i) return;
    }
    parent.set(i, cause);
  });

  const nodes = sorted.map((finding): FindingNode => ({ finding, consequences: [] }));
  const roots: FindingNode[] = [];
  nodes.forEach((node, i) => {
    const p = parent.get(i);
    if (p === undefined) roots.push(node);
    else nodes[p]?.consequences.push(node);
  });
  return roots;
}

/** Every node of the forest, depth first. */
export function flattenNodes(nodes: readonly FindingNode[]): Finding[] {
  return nodes.flatMap((n) => [n.finding, ...flattenNodes(n.consequences)]);
}

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    compareLocations(a.specAt ?? a.codeAt, b.specAt ?? b.codeAt) ||
    compareStrings(a.id, b.id)
  );
}

function compareLocations(a: SourceLocation | undefined, b: SourceLocation | undefined): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

/** Counts per severity, for badges. */
export function severityCounts(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
