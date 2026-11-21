import type { BehaviorModel, Finding } from "@tsv/ir";
import { LineCounter, parseDocument } from "yaml";
import { FindingCollector } from "./findings";
import { normalize } from "./normalize";
import { Locator } from "./positions";
import { specSchema } from "./schema";
import { reportSchemaIssues } from "./schema-issues";

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
  const findings = out.finish();
  return out.hasErrors() ? { findings } : { model: normalized.model, findings };
}
