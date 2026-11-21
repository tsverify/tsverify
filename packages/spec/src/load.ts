import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { BehaviorModel, Finding } from "@tsv/ir";
import { LineCounter, parseDocument } from "yaml";
import { compare, FindingCollector } from "./findings";
import { normalize } from "./normalize";
import { Locator } from "./positions";
import { specSchema } from "./schema";
import { reportSchemaIssues } from "./schema-issues";
import { validate } from "./validate";

export interface SpecResult {
  /** Absent if any finding has severity `error`. */
  model?: BehaviorModel;
  findings: Finding[];
}

/**
 * Parses, validates and normalizes one behavior file. Pure: `file` is only used for locations,
 * finding ids and `model.file`.
 */
export function parseSpec(text: string, file: string): SpecResult {
  const out = new FindingCollector(file);
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const locator = new Locator(doc, lineCounter, text, file);

  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      out.error(locator.span(e.pos[0], e.pos[1]), `YAML syntax error: ${e.message}`);
    }
    return { findings: out.finish() };
  }
  for (const w of doc.warnings) {
    out.warning(locator.span(w.pos[0], w.pos[1]), `YAML: ${w.message}`);
  }

  let raw: unknown;
  try {
    raw = doc.toJS();
  } catch (e) {
    out.error(locator.span(0), `YAML error: ${e instanceof Error ? e.message : String(e)}`);
    return { findings: out.finish() };
  }
  const behavior = (raw as { behavior?: unknown } | null)?.behavior;
  if (typeof behavior === "string") out.behavior = behavior;

  const parsed = specSchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) {
    reportSchemaIssues(parsed.error.issues, raw, locator, out);
    return { findings: out.finish() };
  }

  const normalized = normalize(parsed.data, file, locator, out);
  validate(parsed.data, normalized, locator, out);
  const findings = out.finish();
  return out.hasErrors() ? { findings } : { model: normalized.model, findings };
}

/**
 * Reads and parses one behavior file. `path` is resolved against `root` (default: the current
 * directory), and `model.file` and every location are relative to `root`, with `/` separators.
 * An unreadable file is reported as an `invalid-spec` finding, not thrown.
 */
export async function loadSpec(path: string, options: { root?: string } = {}): Promise<SpecResult> {
  const root = resolve(options.root ?? process.cwd());
  const absolute = resolve(root, path);
  const file = relative(root, absolute).split(sep).join("/");
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (e) {
    const out = new FindingCollector(file);
    const reason =
      (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
    out.error({ file, line: 1, column: 1 }, `cannot read behavior file "${file}" (${reason})`);
    return { findings: out.finish() };
  }
  return parseSpec(text, file);
}

const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".tsv", "dist"]);

/**
 * Every `**\/*.behavior.yaml` under `root`, skipping node_modules, .git, .tsv and dist (symlinks
 * are not followed). Sorted, relative to `root`, with `/` separators.
 */
export async function findSpecFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith(".behavior.yaml")) {
        found.push(rel);
      }
    }
  };
  await walk(resolve(root), "");
  return found.sort(compare);
}
