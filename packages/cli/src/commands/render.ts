import type { BehaviorModel } from "@tsverify/ir";
import { formatFindings, permissionMatrixMarkdown, summarize, toMermaid } from "@tsverify/render";
import { loadSpec } from "@tsverify/spec";
import { ExitCode, UsageError } from "../exit-codes";
import type { Io } from "../io";

const VIEWS = {
  mermaid: (model: BehaviorModel) => toMermaid(model),
  matrix: permissionMatrixMarkdown,
  summary: summarize,
} as const;

type View = keyof typeof VIEWS;

export type RenderCommandOptions = { [K in View]?: unknown };

/**
 * `tsverify render <spec> [--mermaid | --matrix | --summary]` (default `--mermaid`): one spec as a
 * Mermaid state diagram, a Markdown permission matrix, or a plain-English summary on stdout.
 * Findings go to stderr, so stdout stays pipeable; an invalid spec renders nothing (exit 2).
 */
export async function renderCommand(
  io: Io,
  spec: string,
  options: RenderCommandOptions,
): Promise<ExitCode> {
  const view = pickView(options);
  const { model, findings } = await loadSpec(spec, { root: io.cwd });
  if (findings.length > 0) io.stderr(formatFindings(findings, { cwd: io.cwd }));
  if (!model) return ExitCode.InvalidInput;
  io.stdout(VIEWS[view](model));
  return ExitCode.Ok;
}

function pickView(options: RenderCommandOptions): View {
  const chosen = (Object.keys(VIEWS) as View[]).filter((v) => options[v] === true);
  if (chosen.length > 1) {
    throw new UsageError(`choose one of ${chosen.map((v) => `--${v}`).join(", ")}`);
  }
  return chosen[0] ?? "mermaid";
}
