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

export type LinkKind = "impl" | "client" | "guard" | "storage" | "tsconfig";

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

/** Per-write findings that `assemble.ts` repeats for each transition whose impl reaches the write. */
const PER_TRANSITION: ReadonlySet<string> = new Set(["from-state", "read", "storage"]);

/**
 * One finding for a write that several transitions' impls reach (a shared helper doing a bulk
 * update for six entry points): the per-transition copies of the same warning (same kind, same
 * place, same text after the transition's name, same hint) become one, naming every transition,
 * with the id of the first by name.
 */
export function mergeSharedWrites(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  const out: Finding[] = [];
  for (const f of findings) {
    const property = f.id.split(":")[2] ?? "";
    const prefix = `${f.transition}: `;
    if (
      f.category !== "unanalyzable" ||
      !PER_TRANSITION.has(property) ||
      f.transition === undefined ||
      f.codeAt === undefined ||
      !f.message.startsWith(prefix)
    ) {
      out.push(f);
      continue;
    }
    const at = `${f.codeAt.file}:${f.codeAt.line}:${f.codeAt.column}`;
    const key = [property, at, f.message.slice(prefix.length), f.hint ?? ""].join("\u0000");
    const group = groups.get(key);
    if (group) group.push(f);
    else {
      groups.set(key, [f]);
      out.push(f);
    }
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => compareStrings(a.transition ?? "", b.transition ?? ""));
    const first = group[0] as Finding;
    const names = group.map((f) => f.transition as string);
    const rest = first.message.slice(`${first.transition}: `.length);
    const merged = {
      ...first,
      message: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}: ${rest}`,
    };
    const original = group.find((f) => out.includes(f)) as Finding;
    out[out.indexOf(original)] = merged;
  }
  return out;
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
