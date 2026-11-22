import type {
  BehaviorDiff,
  BehaviorModel,
  ChangeKind,
  FieldChange,
  ItemChange,
} from "@tsverify/ir";
import { compareStrings, diffModels } from "@tsverify/ir";
import { DIFF_MARKERS, toMermaidDiff } from "./diff-mermaid";
import { type Formatter, plainFormatter } from "./findings";

/** One behavior file on both sides of a diff. At least one side is present. */
export interface DiffEntry {
  /** The file's path, shown as-is (the CLI passes it relative to the cwd). */
  file: string;
  base?: BehaviorModel;
  head?: BehaviorModel;
}

export interface DiffRenderOptions {
  /** Label of the base side, e.g. the git ref `origin/main`. */
  base: string;
  /** Label of the head side (default `working tree`). */
  head?: string;
  /** One more line of context under the summary, e.g. what `--enforced-only` left out. */
  note?: string;
}

export interface DiffTextOptions extends DiffRenderOptions {
  formatter?: Formatter;
}

/** First line of the Markdown: lets CI find and update its own PR comment (a "sticky" comment). */
export const DIFF_COMMENT_MARKER = "<!-- tsverify-diff -->";

/** Fields whose values are flags: `"yes"` / `""`. */
const FLAG_FIELDS: ReadonlySet<string> = new Set(["atomic", "idempotent", "terminal", "enforced"]);

type Section = "entity" | "states" | "transitions" | "actors" | "rules" | "bindings";

/** Section order, with the singular noun the summary counts in and the Markdown heading. */
const SECTIONS: readonly { key: Section; noun: string; heading: string; column: string }[] = [
  { key: "entity", noun: "top-level field", heading: "Behavior", column: "Field" },
  { key: "states", noun: "state", heading: "States", column: "State" },
  { key: "transitions", noun: "transition", heading: "Transitions", column: "Transition" },
  { key: "actors", noun: "actor", heading: "Actors", column: "Actor" },
  { key: "rules", noun: "rule", heading: "Rules", column: "Rule" },
  { key: "bindings", noun: "binding", heading: "Bindings", column: "Binding" },
];

const KIND_ORDER: readonly ChangeKind[] = ["added", "removed", "changed"];

interface Rendered {
  entry: DiffEntry;
  diff: BehaviorDiff;
  enforced: boolean;
}

/** One row of a section: an item change, or a field change (entity, bindings) as an item. */
interface Row {
  kind: ChangeKind;
  name: string;
  /** The item's field changes; a field-change row has exactly one, its own. */
  fields: FieldChange[];
  /** A field-change row: its one field is the row itself, so the field name is not repeated. */
  isField: boolean;
}

/**
 * `+1 state, +2 transitions, ~1 transition, −1 rule`: changes counted per section (section
 * order, then added, removed, changed). Top-level fields are left out for an added or removed
 * behavior, where they are just the whole file. `no changes` when there is nothing.
 */
export function diffSummary(diff: BehaviorDiff): string {
  const parts: string[] = [];
  for (const { key, noun } of SECTIONS) {
    if (key === "entity" && diff.kind !== "changed") continue;
    const rows = sectionRows(diff, key);
    for (const kind of KIND_ORDER) {
      const n = rows.filter((r) => r.kind === kind).length;
      if (n > 0) parts.push(`${DIFF_MARKERS[kind]}${n} ${noun}${n === 1 ? "" : "s"}`);
    }
  }
  return parts.length === 0 ? "no changes" : parts.join(", ");
}

/**
 * The behavior diff as a PR-ready Markdown comment: a heading per added, removed or changed
 * behavior with a one-line summary, a Mermaid diff diagram (`toMermaidDiff`) and a table of
 * changes per section, where each field change reads `base → head`. Unchanged files are listed
 * in one line at the end. Starts with `DIFF_COMMENT_MARKER`. Deterministic: entries by file.
 */
export function renderDiffMarkdown(
  entries: readonly DiffEntry[],
  options: DiffRenderOptions,
): string {
  const rendered = prepare(entries);
  const head = options.head ?? "working tree";
  const changed = rendered.filter((r) => r.diff.kind !== "unchanged");
  const unchanged = rendered.filter((r) => r.diff.kind === "unchanged");

  const out: string[] = [DIFF_COMMENT_MARKER, "## Behavior diff", ""];
  const files = `${rendered.length} behavior file${rendered.length === 1 ? "" : "s"}`;
  out.push(
    changed.length === 0
      ? `${code(options.base)} → ${head}: no behavior changes (${files} compared).`
      : `${code(options.base)} → ${head}: ${changed.length} of ${files} changed.`,
  );
  if (options.note !== undefined) out.push("", options.note);

  for (const r of changed) {
    out.push("", `### ${mdText(r.diff.behavior)} · ${r.diff.kind}`, "");
    const meta = [code(r.entry.file), ...(r.enforced ? ["enforced"] : []), diffSummary(r.diff)];
    out.push(meta.join(" · "));
    out.push("", "```mermaid", toMermaidDiff(r.entry.base, r.entry.head, r.diff).trimEnd(), "```");
    out.push(
      "",
      "<sub>+ added · − removed · ~ changed · thick arrow: added · dotted arrow: removed · stadium: terminal state</sub>",
    );
    // A whole file added or removed: its tables just restate the file, so they start collapsed.
    const whole = r.diff.kind !== "changed";
    if (whole)
      out.push("", `<details><summary>Everything the ${r.diff.kind} file declares</summary>`);
    for (const section of SECTIONS) {
      const rows = sectionRows(r.diff, section.key);
      if (rows.length === 0) continue;
      out.push("", `**${section.heading}**`, "");
      out.push(`| | ${section.column} | Change |`, "|---|---|---|");
      for (const row of rows) {
        const change =
          row.fields.length === 0
            ? row.kind
            : row.fields.map((f) => changeText(f, row, code)).join("<br>");
        out.push(`| ${DIFF_MARKERS[row.kind]} | ${cell(code(row.name))} | ${cell(change)} |`);
      }
    }
    if (whole) out.push("", "</details>");
  }
  if (unchanged.length > 0 && changed.length > 0) {
    out.push("", `Unchanged: ${unchanged.map((r) => code(r.entry.file)).join(", ")}.`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * A compact terminal view: one line per file (path, behavior, kind, summary), then one line per
 * change (`~ transition refund  atomic: yes → no`), then a count line. Added and removed items
 * are listed by name only; the Markdown has their fields.
 */
export function renderDiffText(entries: readonly DiffEntry[], options: DiffTextOptions): string {
  const f = options.formatter ?? plainFormatter;
  const color: Record<ChangeKind, (s: string) => string> = {
    added: f.green,
    removed: f.red,
    changed: f.yellow,
  };
  const rendered = prepare(entries);
  const lines: string[] = [];
  for (const r of rendered) {
    const kind = r.diff.kind === "unchanged" ? f.dim("unchanged") : color[r.diff.kind](r.diff.kind);
    const tags = [kind, ...(r.enforced ? ["enforced"] : [])].join(" · ");
    lines.push(`${f.bold(r.entry.file)}  ${r.diff.behavior}  ${tags}`);
    if (r.diff.kind === "unchanged") continue;
    lines.push(`  ${f.dim(diffSummary(r.diff))}`);
    for (const section of SECTIONS) {
      for (const row of sectionRows(r.diff, section.key)) {
        const what = section.key === "entity" ? "" : `${section.noun} `;
        let line = `${color[row.kind](DIFF_MARKERS[row.kind])} ${what}${row.name}`;
        if (row.kind === "changed" || section.key === "entity" || section.key === "bindings") {
          line += `  ${row.fields.map((c) => changeText(c, row, (s) => s)).join(" · ")}`;
        }
        lines.push(`  ${line}`);
      }
    }
  }
  const changed = rendered.filter((r) => r.diff.kind !== "unchanged").length;
  const head = options.head ?? "working tree";
  if (lines.length > 0) lines.push("");
  if (options.note !== undefined) lines.push(options.note);
  lines.push(
    `${changed} of ${rendered.length} behavior file${rendered.length === 1 ? "" : "s"} changed (${options.base} → ${head})`,
  );
  return `${lines.join("\n")}\n`;
}

function prepare(entries: readonly DiffEntry[]): Rendered[] {
  return [...entries]
    .sort((a, b) => compareStrings(a.file, b.file))
    .map((entry) => ({
      entry,
      diff: diffModels(entry.base, entry.head),
      enforced: entry.head?.enforced === true || entry.base?.enforced === true,
    }));
}

function sectionRows(diff: BehaviorDiff, key: Section): Row[] {
  if (key === "entity" || key === "bindings") {
    return diff[key].map((f) => ({
      kind: fieldKind(f),
      name: f.field,
      fields: [f],
      isField: true,
    }));
  }
  return diff[key].map((item: ItemChange) => ({ ...item, isField: false }));
}

/** A field that appears (`""` → value) or disappears; flags and top-level fields only change. */
function fieldKind(f: FieldChange): ChangeKind {
  if (FLAG_FIELDS.has(f.field)) return "changed";
  if (f.base === "") return "added";
  if (f.head === "") return "removed";
  return "changed";
}

function display(field: string, value: string): string {
  if (FLAG_FIELDS.has(field)) return value === "" ? "no" : value;
  return value === "" ? "(none)" : value;
}

/**
 * `field: base → head` for a changed field, and only the value that exists when the field (or
 * its whole item) was added or removed. A field-change row omits the field name (it is the row's).
 */
function changeText(f: FieldChange, row: Row, value: (s: string) => string): string {
  const b = value(display(f.field, f.base));
  const h = value(display(f.field, f.head));
  const kind = row.isField ? fieldKind(f) : row.kind;
  const text = kind === "added" ? h : kind === "removed" ? b : `${b} → ${h}`;
  return row.isField ? text : `${f.field}: ${text}`;
}

/** An inline code span that survives backticks in the text. */
function code(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A table cell: `|` ends the cell even inside a code span (GFM), and rows are one line. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Plain text in a heading: Markdown punctuation is escaped. */
function mdText(text: string): string {
  return text.replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`);
}
