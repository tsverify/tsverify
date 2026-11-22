import type { Finding, Severity, SourceLocation } from "@tsverify/ir";
import { type ComponentChild, h } from "preact";
import { type FindingNode, groupByRootCause } from "../findings-tree";

const ICON: Record<Severity, string> = { error: "✗", warning: "⚠", info: "ℹ" };

export interface FindingsListProps {
  findings: readonly Finding[];
  /** Id of the finding whose trace is being played. */
  selected?: string;
  onPlay?: (finding: Finding) => void;
}

/** Findings grouped by root cause: consequences (`causedBy`) nested under their cause. */
export function FindingsList({ findings, selected, onPlay }: FindingsListProps): ComponentChild {
  if (findings.length === 0) return h("p", { class: "ok" }, "✓ no findings");
  const item = (node: FindingNode, depth: number): ComponentChild => {
    const f = node.finding;
    const locations = [f.specAt, f.codeAt]
      .filter((l): l is SourceLocation => l !== undefined)
      .map((l) => `${l.file}:${l.line}:${l.column}`);
    return h(
      "li",
      { class: `finding ${f.severity}`, key: f.id },
      h(
        "div",
        { class: "finding-head" },
        depth > 0 ? h("span", { class: "muted" }, "↳ consequence: ") : null,
        h("span", { class: `severity ${f.severity}` }, `${ICON[f.severity]} ${f.category}`),
        f.property ? h("span", { class: "property" }, f.property) : null,
        locations.length > 0 ? h("span", { class: "location" }, locations.join(" · ")) : null,
      ),
      h("p", { class: "message" }, f.message),
      f.hint ? h("p", { class: "hint" }, h("span", { class: "muted" }, "hint: "), f.hint) : null,
      f.trace && onPlay
        ? h(
            "button",
            {
              type: "button",
              class: "play-trace",
              "aria-pressed": selected === f.id,
              onClick: () => onPlay(f),
            },
            selected === f.id
              ? "▶ Playing below"
              : `▶ Play counterexample (${f.trace.steps.length} steps)`,
          )
        : null,
      node.consequences.length > 0
        ? h(
            "ul",
            { class: "consequences" },
            node.consequences.map((c) => item(c, depth + 1)),
          )
        : null,
    );
  };
  return h(
    "ul",
    { class: "findings" },
    groupByRootCause(findings).map((n) => item(n, 0)),
  );
}
