/**
 * The extractor's findings: `broken-link` (a spec link does not resolve; input error) and
 * `unanalyzable` (the extractor cannot tell). Ids follow `<category>:<behavior>:<property>[:<subject>]`.
 */
import type { Finding, SourceLocation } from "@tsv/ir";
import { compareStrings } from "@tsv/ir";

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

export function locText(at: SourceLocation): string {
  return `${at.file}:${at.line}:${at.column}`;
}
