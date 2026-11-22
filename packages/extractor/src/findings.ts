/**
 * The extractor's findings: `broken-link` (a spec link does not resolve; input error) and
 * `unanalyzable` (the extractor cannot tell). Ids follow `<category>:<behavior>:<property>[:<subject>]`.
 *
 * Subjects are stable names, never source positions: a transition, function, binding or file
 * name (e.g. `unanalyzable:Orders:write-value:setStatus`). When two findings of one spec would
 * share an id, `uniqueIds` suffixes the later ones (by code location) with `~2`, `~3`, …
 */
import type { Finding, SourceLocation } from "@tsverify/ir";
import { compareStrings } from "@tsverify/ir";

export type LinkKind = "impl" | "client" | "guard" | "tsconfig";

export function brokenLink(
  behavior: string,
  kind: LinkKind,
  subject: string | undefined,
  message: string,
  specAt: SourceLocation | undefined,
  extra: { transition?: string; hint: string },
): Finding {
  return {
    id:
      subject === undefined
        ? `broken-link:${behavior}:${kind}`
        : `broken-link:${behavior}:${kind}:${subject}`,
    category: "broken-link",
    severity: "error",
    message,
    behavior,
    ...(extra.transition !== undefined ? { transition: extra.transition } : {}),
    ...(specAt ? { specAt } : {}),
    hint: extra.hint,
  };
}

export function unanalyzable(
  behavior: string,
  property: string,
  subject: string,
  message: string,
  extra: { transition?: string; codeAt?: SourceLocation; hint: string },
): Finding {
  return {
    id: `unanalyzable:${behavior}:${property}:${subject}`,
    category: "unanalyzable",
    severity: "warning",
    message,
    behavior,
    ...(extra.transition !== undefined ? { transition: extra.transition } : {}),
    ...(extra.codeAt ? { codeAt: extra.codeAt } : {}),
    hint: extra.hint,
  };
}

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) => compareStrings(a.id, b.id) || compareStrings(a.message, b.message),
  );
}

function compareAt(a: SourceLocation | undefined, b: SourceLocation | undefined): number {
  if (!a || !b) return Number(a === undefined) - Number(b === undefined);
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

/** Makes ids unique: colliding findings, ordered by code location then message, get `~2`, `~3`, … */
export function uniqueIds(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const g = groups.get(f.id);
    if (g) g.push(f);
    else groups.set(f.id, [f]);
  }
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => compareAt(a.codeAt, b.codeAt) || compareStrings(a.message, b.message));
    group.forEach((f, i) => {
      if (i > 0) f.id = `${id}~${i + 1}`;
    });
  }
  return findings;
}
