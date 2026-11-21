import type { Finding, Severity, SourceLocation } from "@tsv/ir";
import { compareStrings } from "@tsv/ir";
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
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const ICON: Record<Severity, string> = { error: "✗", warning: "⚠", info: "ℹ" };
const NO_BEHAVIOR = "(no behavior)";

/**
 * Findings as terminal text, grouped by behavior (by name; findings without one come last),
 * then ordered by severity, location and id. Each finding has a headline (severity icon,
 * category, locations) with its message, hint and counterexample indented below. Ends with a
 * count summary line.
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
    for (const finding of group) lines.push(...formatFinding(finding, f, options.cwd));
    lines.push("");
  }
  lines.push(countLine(findings, f));
  return `${lines.join("\n")}\n`;
}

function formatFinding(finding: Finding, f: Formatter, cwd: string | undefined): string[] {
  const color = severityColor(finding.severity, f);
  const locations = [finding.specAt, finding.codeAt]
    .filter((l): l is SourceLocation => l !== undefined)
    .map((l) => formatLocation(l, cwd));
  let headline = `  ${color(`${ICON[finding.severity]} ${finding.category}`)}`;
  if (locations.length > 0) headline += `  ${f.dim(locations.join(" · "))}`;

  const out = [headline];
  for (const line of finding.message.split(/\r?\n/)) out.push(`    ${line}`);
  if (finding.hint !== undefined) {
    const [first = "", ...rest] = finding.hint.split(/\r?\n/);
    out.push(`    ${f.dim("hint:")} ${first}`);
    for (const line of rest) out.push(`          ${line}`);
  }
  if (finding.trace) {
    out.push(`    ${f.dim("trace:")}`);
    for (const line of traceToText(finding.trace).trimEnd().split("\n")) out.push(`      ${line}`);
  }
  return out;
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
