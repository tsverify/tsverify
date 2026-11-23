import type { BehaviorDiff, BehaviorModel } from "@tsverify/ir";
import { compareStrings, diffModels } from "@tsverify/ir";
import { type DiffEntry, renderDiffMarkdown, renderDiffText } from "@tsverify/render";
import { UsageError } from "../exit-codes";
import type { Io } from "../io";
import { terminalFormatter } from "./pretty";

export const DIFF_FORMATS = ["markdown", "json", "pretty"] as const;
export type DiffFormat = (typeof DIFF_FORMATS)[number];

/** Validates a raw `tsverify diff --format` value from cac. */
export function parseDiffFormat(value: unknown): DiffFormat {
  const format = DIFF_FORMATS.find((f) => f === value);
  if (format === undefined) {
    throw new UsageError(
      `--format must be one of ${DIFF_FORMATS.join(", ")} (got ${String(value)})`,
    );
  }
  return format;
}

/** One behavior file paired by path across the two sides. */
export interface DiffPair {
  /** Relative to the cwd, with `/` separators. */
  file: string;
  base?: BehaviorModel;
  head?: BehaviorModel;
}

/**
 * The ref as given (`--base`) and the commit it resolved to. When the paths are in several git
 * repositories, `commit` is the first one's and `commits` has each (repository root relative to
 * the cwd → commit).
 */
export interface DiffBase {
  ref: string;
  commit: string;
  commits?: Record<string, string>;
}

export interface DiffRun {
  base: DiffBase;
  /** Sorted by file. */
  pairs: DiffPair[];
  /** `--enforced-only`: how many paired files were left out. */
  enforcedOnly?: { skipped: number };
}

/**
 * The `tsverify diff --format json` document. A contract for CI and agents like `JsonReport`: bump
 * `version` on any breaking change. Deterministic.
 */
export interface JsonDiffReport {
  version: 1;
  base: DiffBase;
  /** The head side is always the working tree. */
  head: "working tree";
  specs: JsonDiffSpec[];
  summary: { files: number; added: number; removed: number; changed: number; unchanged: number };
}

export interface JsonDiffSpec {
  /** Relative to the cwd. A renamed file is one removed and one added entry. */
  file: string;
  /** Present (and `true`) when either side says `enforced: true`. */
  enforced?: true;
  diff: BehaviorDiff;
}

export function toJsonDiffReport(run: DiffRun): JsonDiffReport {
  const specs = run.pairs.map(({ file, base, head }): JsonDiffSpec => {
    const spec: JsonDiffSpec = { file, diff: diffModels(base, head) };
    if (isEnforced({ file, base, head })) spec.enforced = true;
    return spec;
  });
  const count = (kind: BehaviorDiff["kind"]) => specs.filter((s) => s.diff.kind === kind).length;
  return {
    version: 1,
    base: run.base,
    head: "working tree",
    specs,
    summary: {
      files: specs.length,
      added: count("added"),
      removed: count("removed"),
      changed: count("changed"),
      unchanged: count("unchanged"),
    },
  };
}

/** `--enforced-only` keeps a pair when either side is enforced: turning it off is a change too. */
export function isEnforced(pair: DiffPair): boolean {
  return pair.base?.enforced === true || pair.head?.enforced === true;
}

/** The whole stdout of `tsverify diff`. */
export function formatDiff(run: DiffRun, format: DiffFormat, io: Io): string {
  if (format === "json") return `${JSON.stringify(toJsonDiffReport(run), null, 2)}\n`;
  const entries: DiffEntry[] = [...run.pairs].sort((a, b) => compareStrings(a.file, b.file));
  const options = { base: run.base.ref, ...noteOption(run) };
  return format === "markdown"
    ? renderDiffMarkdown(entries, options)
    : renderDiffText(entries, { ...options, formatter: terminalFormatter(io) });
}

function noteOption(run: DiffRun): { note?: string } {
  const skipped = run.enforcedOnly?.skipped;
  if (skipped === undefined) return {};
  const specs = `${skipped} spec${skipped === 1 ? "" : "s"}`;
  if (run.pairs.length === 0) {
    return {
      note: `No enforced specs: --enforced-only keeps only specs with \`enforced: true\` on either side, and none of the ${specs} found has it.`,
    };
  }
  return skipped === 0
    ? {}
    : { note: `--enforced-only: skipped ${specs} without \`enforced: true\`.` };
}
