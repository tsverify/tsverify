import type { BehaviorDiff, BehaviorModel, ChangeKind } from "@tsverify/ir";
import { compareStrings, diffModels } from "@tsverify/ir";
import { diagramStates, edgeSources, sortedTransitions, transitionLabel } from "./mermaid";
import { assignMermaidIds, escapeMermaidText } from "./mermaid-text";

/**
 * Text markers for diff items, put in labels so the diagram (and the Markdown around it) stays
 * readable without color: GitHub themes vary, and some readers see no color at all.
 */
export const DIFF_MARKERS: Record<ChangeKind, string> = {
  added: "+",
  removed: "−",
  changed: "~",
};

type Status = ChangeKind | "same";

/** Edge styles per status. `linkStyle` colors them; the arrow shape alone already tells them apart. */
const ARROW: Record<Status, string> = {
  added: "==>",
  removed: "-.->",
  changed: "-->",
  same: "-->",
};

const COLOR: Record<ChangeKind, string> = {
  added: "#16a34a",
  removed: "#dc2626",
  changed: "#d97706",
};

const NODE_STYLE: Record<ChangeKind, string> = {
  added: `fill:#dcfce7,stroke:${COLOR.added},stroke-width:2px,color:#111827`,
  removed: `fill:#fee2e2,stroke:${COLOR.removed},stroke-width:2px,stroke-dasharray:4 3,color:#111827`,
  changed: `fill:#fef3c7,stroke:${COLOR.changed},stroke-width:2px,color:#111827`,
};

const KINDS: readonly ChangeKind[] = ["added", "removed", "changed"];

/** Id of the start marker node. Reserved, like the flowchart keywords below. */
const START_ID = "start";

/**
 * Words the flowchart parser treats as keywords (compared case-insensitively). `end` in
 * particular breaks a flowchart when used as a node id.
 */
const FLOWCHART_KEYWORDS = [
  START_ID,
  "call",
  "class",
  "classDef",
  "click",
  "default",
  "direction",
  "end",
  "flowchart",
  "graph",
  "href",
  "interpolate",
  "linkStyle",
  "style",
  "subgraph",
];

interface Edge {
  from: string;
  to: string;
  label: string;
  status: Status;
}

/**
 * The behavior diff as a Mermaid `flowchart LR`: the head state machine, plus what the base had
 * and the head no longer has. A flowchart rather than a `stateDiagram-v2`, because only
 * flowcharts can style edges (`linkStyle`).
 *
 * - Added states and edges are marked `+`, removed ones `−` (drawn from the base), changed ones
 *   `~` (a transition whose fields changed, on the edges both sides share). The markers are in
 *   the labels, so the diff reads the same without color.
 * - Arrows: `==>` added, `-.->` removed, `-->` otherwise. Colors come on top via `linkStyle`
 *   and `classDef`.
 * - Edges are per (transition, source state), as in `toMermaid`: a transition that gains a
 *   source state gets one `+` edge, and one whose target changed shows a `−` and a `+` edge.
 * - Shapes: rounded = state, stadium = terminal state, circle = start.
 *
 * Deterministic: states in head order then removed states in base order, edges by transition
 * name (head edges first, then removed ones).
 */
export function toMermaidDiff(
  base: BehaviorModel | undefined,
  head: BehaviorModel | undefined,
  diff: BehaviorDiff = diffModels(base, head),
): string {
  const headStates = head ? diagramStates(head) : [];
  const baseStates = base ? diagramStates(base) : [];
  const headSet = new Set(headStates);
  const states = [...headStates, ...baseStates.filter((s) => !headSet.has(s))];
  const ids = assignMermaidIds(states, FLOWCHART_KEYWORDS);
  const id = (s: string) => ids.get(s) ?? s;

  const stateStatus = new Map<string, Status>(diff.states.map((s) => [s.name, s.kind]));
  const terminal = new Set([
    ...(head?.entity.terminal ?? []),
    ...(base?.entity.terminal ?? []).filter((s) => !headSet.has(s)),
  ]);

  const lines = ["flowchart LR"];
  lines.push(`  ${START_ID}(("start"))`);
  for (const s of states) {
    const status = stateStatus.get(s) ?? "same";
    const text = quote(marked(s, status));
    lines.push(terminal.has(s) ? `  ${id(s)}([${text}])` : `  ${id(s)}(${text})`);
  }

  const edges: Edge[] = [...startEdges(base, head), ...transitionEdges(base, head, diff)];
  for (const e of edges) {
    const from = e.from === START_ID ? START_ID : id(e.from);
    const label = e.label === "" ? "" : `|${quote(e.label)}|`;
    lines.push(`  ${from} ${ARROW[e.status]}${label} ${id(e.to)}`);
  }

  for (const kind of KINDS) {
    const indexes = edges.flatMap((e, i) => (e.status === kind ? [i] : []));
    if (indexes.length > 0) {
      lines.push(`  linkStyle ${indexes.join(",")} stroke:${COLOR[kind]},stroke-width:3px`);
    }
  }
  for (const kind of KINDS) {
    const marked = states.filter((s) => stateStatus.get(s) === kind);
    if (marked.length === 0) continue;
    lines.push(`  classDef ${kind} ${NODE_STYLE[kind]}`);
    lines.push(`  class ${marked.map(id).join(",")} ${kind}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The start arrow; when the initial state changed, the old one is drawn as removed. */
function startEdges(base: BehaviorModel | undefined, head: BehaviorModel | undefined): Edge[] {
  const b = base?.entity.initial;
  const h = head?.entity.initial;
  if (b !== undefined && h !== undefined && b !== h) {
    return [
      { from: START_ID, to: h, label: marked("", "added"), status: "added" },
      { from: START_ID, to: b, label: marked("", "removed"), status: "removed" },
    ];
  }
  const initial = h ?? b;
  return initial === undefined ? [] : [{ from: START_ID, to: initial, label: "", status: "same" }];
}

function transitionEdges(
  base: BehaviorModel | undefined,
  head: BehaviorModel | undefined,
  diff: BehaviorDiff,
): Edge[] {
  const headEdges = edgesOf(head);
  const baseEdges = edgesOf(base);
  const changed = new Set(diff.transitions.filter((t) => t.kind === "changed").map((t) => t.name));
  const names = [...new Set([...headEdges.keys(), ...baseEdges.keys()])].sort(compareStrings);

  const out: Edge[] = [];
  for (const name of names) {
    const h = headEdges.get(name) ?? [];
    const b = baseEdges.get(name) ?? [];
    const key = (e: Edge) => `${e.from}\u0000${e.to}`;
    const inBase = new Set(b.map(key));
    const inHead = new Set(h.map(key));
    for (const e of h) {
      const status: Status = !inBase.has(key(e)) ? "added" : changed.has(name) ? "changed" : "same";
      out.push({ ...e, status, label: marked(e.label, status) });
    }
    for (const e of b) {
      if (!inHead.has(key(e)))
        out.push({ ...e, status: "removed", label: marked(e.label, "removed") });
    }
  }
  return out;
}

/** Edges of each transition (by name), one per source state, unmarked. */
function edgesOf(model: BehaviorModel | undefined): Map<string, Edge[]> {
  const out = new Map<string, Edge[]>();
  if (model === undefined) return out;
  const states = diagramStates(model);
  for (const t of sortedTransitions(model)) {
    const label = transitionLabel(t);
    out.set(
      t.name,
      edgeSources(t, states).map((from) => ({ from, to: t.to, label, status: "same" as const })),
    );
  }
  return out;
}

function marked(text: string, status: Status): string {
  if (status === "same") return text;
  return text === "" ? DIFF_MARKERS[status] : `${DIFF_MARKERS[status]} ${text}`;
}

/** A quoted flowchart label. `|` would end an edge label, so it is escaped like the rest. */
function quote(text: string): string {
  return `"${escapeMermaidText(text).replace(/\|/g, "#124;")}"`;
}
