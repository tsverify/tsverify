import type { Finding, Severity, SourceLocation } from "@tsverify/ir";
import { compareStrings } from "@tsverify/ir";
import { traceToText } from "./trace";

/** Terminal styling, injected so this package stays free of TTY detection and color libraries. */
export interface Formatter {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
}

const identity = (s: string) => s;

/** No styling: for logs, files, `NO_COLOR` and tests. */
export const plainFormatter: Formatter = {
  bold: identity,
  dim: identity,
  red: identity,
  yellow: identity,
  green: identity,
  cyan: identity,
};

export interface FormatFindingsOptions {
  formatter?: Formatter;
  /** Absolute project root. Locations under it are shown relative to it; others are left as-is. */
  cwd?: string;
  /** Append the `N errors · N warnings · N info` line (default true). Callers with their own summary turn it off. */
  countLine?: boolean;
  /**
   * Print each finding with `causedBy` indented under its cause, as `↳ consequence: …` (trace
   * kept), instead of as a sibling (default false). Only causes in the same behavior group
   * count: a consequence whose causes are all absent renders normally. With several causes
   * present, it goes under the first one in display order.
   */
  groupCauses?: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const ICON: Record<Severity, string> = { error: "✗", warning: "⚠", info: "ℹ" };
const NO_BEHAVIOR = "(no behavior)";

/**
 * Findings as terminal text, grouped by behavior (by name; findings without one come last),
 * then ordered by severity, location and id. Each finding has a headline (severity icon,
 * category, locations) with its message, hint and counterexample indented below. With
 * `groupCauses`, consequences follow their cause, one level deeper. Ends with a count summary
 * line (which counts consequences too) unless `countLine: false`.
 */
export function formatFindings(findings: Finding[], options: FormatFindingsOptions = {}): string {
  const f = options.formatter ?? plainFormatter;
  if (findings.length === 0) return `${f.green("✓ no findings")}\n`;

  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.behavior ?? NO_BEHAVIOR;
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  const names = [...groups.keys()].sort((a, b) => {
    if (a === NO_BEHAVIOR || b === NO_BEHAVIOR) return a === b ? 0 : a === NO_BEHAVIOR ? 1 : -1;
    return compareStrings(a, b);
  });

  const lines: string[] = [];
  for (const name of names) {
    lines.push(f.bold(name));
    const group = [...(groups.get(name) ?? [])].sort(compareFindings);
    const arranged = options.groupCauses
      ? nestConsequences(group)
      : group.map((finding) => ({ finding, depth: 0 }));
    for (const { finding, depth } of arranged) {
      lines.push(...formatFinding(finding, f, options.cwd, depth));
    }
    lines.push("");
  }
  if (options.countLine !== false) lines.push(countLine(findings, f));
  else lines.pop();
  return `${lines.join("\n")}\n`;
}

/**
 * `group` (already sorted) in display order with nesting depths: every finding whose `causedBy`
 * names another finding of the group follows that cause (the first one in `group` order), one
 * level deeper, after the cause's other consequences that sort before it. A link that would close
 * a cycle is ignored, so every finding is printed exactly once.
 */
function nestConsequences(group: readonly Finding[]): { finding: Finding; depth: number }[] {
  const position = new Map<string, number>();
  group.forEach((finding, i) => {
    if (!position.has(finding.id)) position.set(finding.id, i);
  });
  const parent = new Map<number, number>();
  group.forEach((finding, i) => {
    const causes = (finding.causedBy ?? [])
      .map((id) => position.get(id))
      .filter((p): p is number => p !== undefined && p !== i);
    if (causes.length === 0) return;
    const cause = Math.min(...causes);
    // Walk up from the cause: reaching this finding means the link would close a cycle.
    for (let p: number | undefined = cause; p !== undefined; p = parent.get(p)) {
      if (p === i) return;
    }
    parent.set(i, cause);
  });

  const children = new Map<number, number[]>();
  for (const [child, cause] of [...parent].sort(([a], [b]) => a - b)) {
    children.set(cause, [...(children.get(cause) ?? []), child]);
  }
  const out: { finding: Finding; depth: number }[] = [];
  const visit = (i: number, depth: number) => {
    out.push({ finding: group[i] as Finding, depth });
    for (const child of children.get(i) ?? []) visit(child, depth + 1);
  };
  group.forEach((_, i) => {
    if (!parent.has(i)) visit(i, 0);
  });
  return out;
}

/** One finding's lines; `depth > 0` marks a consequence printed under its cause. */
function formatFinding(
  finding: Finding,
  f: Formatter,
  cwd: string | undefined,
  depth = 0,
): string[] {
  const color = severityColor(finding.severity, f);
  const locations = [finding.specAt, finding.codeAt]
    .filter((l): l is SourceLocation => l !== undefined)
    .map((l) => formatLocation(l, cwd));
  const pad = "  ".repeat(depth);
  const label = color(`${ICON[finding.severity]} ${finding.category}`);
  let headline = depth === 0 ? `  ${label}` : `  ${pad}${f.dim("↳ consequence:")} ${label}`;
  if (locations.length > 0) headline += `  ${f.dim(locations.join(" · "))}`;

  const out = [headline];
  for (const line of finding.message.split(/\r?\n/)) out.push(`    ${pad}${line}`);
  if (finding.hint !== undefined) {
    const [first = "", ...rest] = finding.hint.split(/\r?\n/);
    out.push(`    ${pad}${f.dim("hint:")} ${first}`);
    for (const line of rest) out.push(`          ${pad}${line}`);
  }
  if (finding.detail !== undefined) {
    out.push(`    ${pad}${f.dim("detail:")}`);
    for (const line of detailLines(finding.detail, finding.message)) {
      out.push(`      ${pad}${f.dim(line)}`);
    }
  }
  if (finding.trace) {
    out.push(`    ${pad}${f.dim("trace:")}`);
    for (const line of traceToText(finding.trace).trimEnd().split("\n")) {
      out.push(`      ${pad}${line}`);
    }
  }
  return out;
}

/** Lines of a finding's `detail` shown in the terminal (the JSON output has it whole). */
export const DETAIL_LINES = 8;

/**
 * A finding's `detail`, trimmed for the terminal: its first line when the message already says it,
 * and stack frames in `node_modules` and Node's own, are left out (the error's own lines and
 * `Caused by:` lines stay), then at most `DETAIL_LINES` lines, the last saying how many more
 * there are.
 */
export function detailLines(detail: string, message = ""): string[] {
  const all = detail.split(/\r?\n/);
  const first = (all[0] ?? "").replace(/^[A-Za-z]*Error: /, "").trim();
  if (first !== "" && message.includes(first)) all.shift();
  const lines = all
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !/^\s*at .*(node_modules|node:internal|\(node:)/.test(line))
    .map((line) => line.replace(/^\s+at /, "at "));
  if (lines.length <= DETAIL_LINES) return lines;
  const more = lines.length - (DETAIL_LINES - 1);
  return [
    ...lines.slice(0, DETAIL_LINES - 1),
    `… ${more} more line${more === 1 ? "" : "s"} (the JSON output has them all)`,
  ];
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    compareLocations(a.specAt ?? a.codeAt, b.specAt ?? b.codeAt) ||
    compareStrings(a.id, b.id)
  );
}

/** By file, line, column; findings without a location sort after those with one. */
function compareLocations(a: SourceLocation | undefined, b: SourceLocation | undefined): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column;
}

function formatLocation(loc: SourceLocation, cwd: string | undefined): string {
  return `${relativePath(loc.file, cwd)}:${loc.line}:${loc.column}`;
}

/** Strips `cwd` from paths under it. No `node:path`: this package stays platform-free. */
function relativePath(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  const base = cwd.replace(/[\\/]+$/, "");
  if (file === base) return ".";
  const rest = file.slice(base.length);
  return file.startsWith(base) && /^[\\/]/.test(rest) ? rest.slice(1) : file;
}

function severityColor(severity: Severity, f: Formatter): (s: string) => string {
  return severity === "error" ? f.red : severity === "warning" ? f.yellow : f.cyan;
}

function countLine(findings: Finding[], f: Formatter): string {
  const count = (s: Severity) => findings.filter((x) => x.severity === s).length;
  const part = (s: Severity, singular: string, plural: string) => {
    const n = count(s);
    const text = `${n} ${n === 1 ? singular : plural}`;
    return n === 0 ? f.dim(text) : severityColor(s, f)(text);
  };
  return [
    part("error", "error", "errors"),
    part("warning", "warning", "warnings"),
    part("info", "info", "info"),
  ].join(f.dim(" · "));
}
