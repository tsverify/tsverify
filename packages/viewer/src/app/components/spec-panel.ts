import type { Finding, Trace } from "@tsv/ir";
import { type ComponentChild, h } from "preact";
import { useState } from "preact/hooks";
import type { SpecView } from "../../view-data";
import { Diagram } from "./diagram";
import { FindingsList } from "./findings-list";
import { MatrixTable, SummaryView } from "./model-views";
import { PlaybackView } from "./playback-view";

export interface SpecPanelProps {
  spec: SpecView;
  /** Id of the finding whose trace is played. */
  playing?: string;
  onPlay: (finding: Finding) => void;
  /** Initial playback step (tests). */
  start?: number;
}

/** One behavior file: diagram (spec or code model), summary, matrix, findings and playback. */
export function SpecPanel({ spec, playing, onPlay, start }: SpecPanelProps): ComponentChild {
  const [which, setWhich] = useState<"spec" | "code">("spec");
  const shown = which === "code" && spec.mermaid.code ? "code" : "spec";
  const source = spec.mermaid[shown];
  const traced = spec.findings.find(
    (f): f is Finding & { trace: Trace } => f.id === playing && f.trace !== undefined,
  );
  const traceModel = traced ? (traced.trace.model === "code" ? spec.code : spec.spec) : undefined;
  const title = spec.behavior ?? spec.file;

  return h(
    "article",
    { class: "spec", "aria-labelledby": "spec-title" },
    h(
      "header",
      { class: "spec-header" },
      h("h2", { id: "spec-title" }, title),
      h(
        "p",
        { class: "muted" },
        h("code", null, spec.file),
        spec.project === null ? " · spec only" : ` · project ${spec.project}`,
      ),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "findings-title" },
      h("h3", { id: "findings-title" }, `Findings (${spec.findings.length})`),
      h(FindingsList, { findings: spec.findings, selected: playing, onPlay }),
    ),
    traced
      ? h(
          "div",
          { class: "card" },
          h(PlaybackView, {
            key: `${traced.id}:${traced.trace.steps.length}`,
            finding: traced,
            model: traceModel,
            start,
          }),
        )
      : null,
    source
      ? h(
          "section",
          { class: "card", "aria-labelledby": "diagram-title" },
          h(
            "div",
            { class: "card-head" },
            h("h3", { id: "diagram-title" }, "State diagram"),
            spec.mermaid.code
              ? h(
                  "div",
                  { class: "toggle", role: "group", "aria-label": "Model" },
                  (["spec", "code"] as const).map((m) =>
                    h(
                      "button",
                      {
                        type: "button",
                        "aria-pressed": shown === m,
                        onClick: () => setWhich(m),
                      },
                      m === "spec" ? "Spec model" : "Code model",
                    ),
                  ),
                )
              : null,
          ),
          h(Diagram, { source, label: `State diagram of ${title} (${shown} model)` }),
        )
      : null,
    spec.spec
      ? h(
          "div",
          { class: "two-col" },
          h(
            "section",
            { class: "card", "aria-labelledby": "summary-title" },
            h("h3", { id: "summary-title" }, "Summary"),
            h(SummaryView, { model: spec.spec }),
          ),
          h(
            "section",
            { class: "card", "aria-labelledby": "matrix-title" },
            h("h3", { id: "matrix-title" }, "Permission matrix"),
            h(MatrixTable, { model: spec.spec }),
          ),
        )
      : null,
  );
}
