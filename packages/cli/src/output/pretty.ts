import type { CheckStats } from "@tsv/checker";
import { type Formatter, formatFindings, plainFormatter } from "@tsv/render";
import pc from "picocolors";
import type { Io } from "../io";
import { allFindings, countSeverity, type Report, type SpecReport } from "../report";

const colorFormatter: Formatter = pc.createColors(true);

/**
 * Colors are on when stdout is a TTY, unless `NO_COLOR` is set (non-empty, per no-color.org).
 * `FORCE_COLOR` overrides the TTY check either way (`0`/`false` force them off).
 */
export function colorsEnabled(io: Io): boolean {
  const { NO_COLOR, FORCE_COLOR, TERM } = io.env;
  if (NO_COLOR !== undefined && NO_COLOR !== "") return false;
  if (FORCE_COLOR !== undefined) return FORCE_COLOR !== "0" && FORCE_COLOR !== "false";
  return io.isTTY && TERM !== "dumb";
}

export function terminalFormatter(io: Io): Formatter {
  return colorsEnabled(io) ? colorFormatter : plainFormatter;
}

/**
 * The findings (via `@tsv/render`), then one summary line. `check` reports (specs with a
 * `project`) get one section per spec, headed by the spec file and its project root.
 */
export function formatPretty(report: Report, io: Io): string {
  const f = terminalFormatter(io);
  const options = { formatter: f, cwd: io.cwd };
  let out = "";
  if (report.specs.some((s) => s.project !== undefined)) {
    for (const spec of report.specs) {
      out += `${f.bold(spec.file)}  ${f.dim(projectLabel(spec, report))}\n`;
      out += `${formatFindings(spec.findings, options)}\n`;
    }
  } else {
    const findings = allFindings(report);
    if (findings.length > 0) out += formatFindings(findings, options);
  }
  return `${out}${summaryLine(report, f)}\n`;
}

function projectLabel(spec: SpecReport, report: Report): string {
  if (report.specOnly) return "spec only";
  return spec.project ? `project: ${spec.project}` : "no project";
}

/** e.g. `✓ 1 spec, 0 errors, 0 warnings (6 spec states, 6 code states)`. */
function summaryLine(report: Report, f: Formatter): string {
  const findings = allFindings(report);
  const errors = countSeverity(findings, "error");
  const warnings = countSeverity(findings, "warning");
  let text = [
    plural(report.specs.length, "spec"),
    plural(errors, "error"),
    plural(warnings, "warning"),
  ].join(", ");
  const counts = [
    stateCount(
      report.specs.map((s) => s.stats),
      "spec",
    ),
    stateCount(
      report.specs.map((s) => s.codeStats),
      "code",
    ),
  ].filter((c) => c !== undefined);
  if (counts.length > 0) text += ` (${counts.join(", ")})`;
  return errors === 0 ? f.green(`✓ ${text}`) : f.red(`✗ ${text}`);
}

/** e.g. `6 code states`, summed over the models checked; undefined when none was. */
function stateCount(stats: (CheckStats | undefined)[], kind: string): string | undefined {
  const checked = stats.filter((s) => s !== undefined);
  if (checked.length === 0) return undefined;
  const states = checked.reduce((sum, s) => sum + s.states, 0);
  return `${states} ${kind} state${states === 1 ? "" : "s"}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
