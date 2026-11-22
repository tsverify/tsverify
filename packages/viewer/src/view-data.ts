import type { BehaviorModel, Finding } from "@tsverify/ir";
import { toMermaid } from "@tsverify/render";

/**
 * Everything the viewer shows, as served by `GET /api/data`. The CLI builds it with the same
 * pipeline as `tsv check` (`buildViewData`), and the server rebuilds it when watched files change.
 */
export interface ViewData {
  /** Increases by one on every rebuild of a running viewer (1 for the first load). */
  version: number;
  /** Absolute directory the `file`/`project` paths and finding locations are relative to. */
  cwd: string;
  /** `--spec-only`: code extraction and conformance were skipped on purpose. */
  specOnly: boolean;
  /** In file order. */
  specs: SpecView[];
  /**
   * Set when the latest rebuild failed (e.g. every spec was deleted). The rest of the data is
   * then the last good build.
   */
  error?: string;
}

/** One behavior file. */
export interface SpecView {
  /** Relative to `ViewData.cwd`, with `/` separators. */
  file: string;
  /** The behavior name, when the file got far enough to declare one. */
  behavior?: string;
  /** Project root relative to the cwd (`.` for the cwd); `null` with `--spec-only` or no tsconfig. */
  project: string | null;
  /** The parsed spec; absent when the file is invalid (its findings say why). */
  spec?: BehaviorModel;
  /** The as-implemented model, when the extractor built one (locations relative to `project`). */
  code?: BehaviorModel;
  /** Every finding of `tsv check` for this file, traces and `causedBy` links included. */
  findings: Finding[];
  /** Mermaid `stateDiagram-v2` sources from `@tsverify/render`, without highlights. */
  mermaid: { spec?: string; code?: string };
}

/** The pipeline results for one spec, as the CLI has them. */
export interface SpecInput {
  file: string;
  behavior?: string;
  project: string | null;
  spec?: BehaviorModel;
  code?: BehaviorModel;
  findings: Finding[];
}

/** Assembles `ViewData`, adding the Mermaid sources. */
export function buildViewData(input: {
  cwd: string;
  specOnly: boolean;
  specs: readonly SpecInput[];
}): ViewData {
  return {
    version: 1,
    cwd: input.cwd,
    specOnly: input.specOnly,
    specs: input.specs.map(specView),
  };
}

function specView(s: SpecInput): SpecView {
  const view: SpecView = {
    file: s.file,
    project: s.project,
    findings: s.findings,
    mermaid: {},
  };
  if (s.behavior !== undefined) view.behavior = s.behavior;
  if (s.spec) {
    view.spec = s.spec;
    view.mermaid.spec = toMermaid(s.spec);
  }
  if (s.code) {
    view.code = s.code;
    view.mermaid.code = toMermaid(s.code);
  }
  return view;
}
