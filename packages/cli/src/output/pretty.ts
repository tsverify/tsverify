import type { CheckStats } from "@tsv/checker";
import { type Formatter, formatFindings, plainFormatter } from "@tsv/render";
import pc from "picocolors";
import type { Io } from "../io";
import { allFindings, countSeverity, type Report, type SpecReport } from "../report";
import type { TestCounts } from "../test-findings";

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
  const options = { formatter: f, cwd: io.cwd, countLine: false };
  let out = "";
  if (report.specs.some((s) => s.project !== undefined)) {
    for (const spec of report.specs) {
      out += `${f.bold(spec.file)}  ${f.dim(projectLabel(spec, report))}\n`;
      out += `${formatFindings(spec.findings, options)}\n`;
    }
    if (report.command === "test") {
      out += `${f.dim("Generated-test results only: static findings (model checking, conformance) come from `tsv check`.")}\n`;
    }
  } else {
    const findings = allFindings(report);
    if (findings.length > 0) out += formatFindings(findings, options);
  }
  return `${out}${summaryLine(report, f)}\n`;
}

function projectLabel(spec: SpecReport, report: Report): string {
  if (report.specOnly) return "spec only";
  const project = spec.project ? `project: ${spec.project}` : "no project";
  const g = spec.generated;
  if (g === undefined) return project;
  return `${project} · ${g.dir}: ${testCountText(g.tests)}`;
}

/** e.g. `35 tests, 34 passed, 1 failed`. */
function testCountText(t: TestCounts): string {
  const parts = [plural(t.total, "test"), `${t.passed} passed`];
  if (t.failed > 0) parts.push(`${t.failed} failed`);
  if (t.missing > 0) parts.push(`${t.missing} not run`);
  return parts.join(", ");
}

/** e.g. `✓ 1 spec, 0 errors, 0 warnings (6 spec states, 6 code states)`. */
function summaryLine(report: Report, f: Formatter): string {
  const findings = allFindings(report);
  const errors = countSeverity(findings, "error");
  const warnings = countSeverity(findings, "warning");
  const generated = report.specs.flatMap((s) => (s.generated ? [s.generated.tests] : []));
  let text = [
    plural(report.specs.length, "spec"),
    ...(report.command === "test"
      ? [
          plural(
            generated.reduce((n, t) => n + t.total, 0),
            "generated test",
          ),
        ]
      : []),
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
