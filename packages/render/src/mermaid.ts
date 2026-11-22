import type { BehaviorModel, EffectDecl, Transition } from "@tsverify/ir";
import { compareStrings } from "@tsverify/ir";
import { assignMermaidIds, escapeMermaidText } from "./mermaid-text";

/** States and transitions (by name) to emphasise, e.g. the ones a counterexample touches. */
export interface Highlight {
  states?: string[];
  transitions?: string[];
}

export interface MermaidOptions {
  highlight?: Highlight;
}

/**
 * Prefix for the label of a highlighted transition.
 *
 * `linkStyle <index>` is a flowchart feature. The `stateDiagram-v2` grammar has no such token
 * (only `classDef`, `class` and `style`, which apply to states), so Mermaid 11 silently reads
 * the line as a state id and the edge stays unstyled. Transitions also cannot take a `class`.
 * So highlighted edges get a visible marker in their label instead, which also survives in
 * plain-text views such as a PR diff.
 */
export const HIGHLIGHT_MARKER = "▶ ";

const HIGHLIGHT_CLASS = "highlight";
const HIGHLIGHT_STYLE = "fill:#fef3c7,stroke:#d97706,stroke-width:3px";

/**
 * Renders a model as a Mermaid `stateDiagram-v2`.
 *
 * Ordering is stable: states in declared order (then any state that only appears in a
 * transition, by name), edges by transition name and then by source state in that same order.
 */
export function toMermaid(model: BehaviorModel, options: MermaidOptions = {}): string {
  const { entity } = model;
  const transitions = sortedTransitions(model);
  const states = diagramStates(model);
  const ids = assignMermaidIds(states);
  const id = (s: string) => ids.get(s) ?? s;

  const highlightedStates = new Set(options.highlight?.states ?? []);
  const highlightedTransitions = new Set(options.highlight?.transitions ?? []);

  const lines = ["stateDiagram-v2"];
  for (const s of states) {
    const sid = id(s);
    lines.push(sid === s ? `  ${sid}` : `  state "${escapeMermaidText(s)}" as ${sid}`);
  }
  lines.push(`  [*] --> ${id(entity.initial)}`);
  for (const t of transitions) {
    const sources = edgeSources(t, states);
    let label = escapeMermaidText(transitionLabel(t));
    if (highlightedTransitions.has(t.name)) label = HIGHLIGHT_MARKER + label;
    for (const from of sources) lines.push(`  ${id(from)} --> ${id(t.to)}: ${label}`);
  }
  const terminal = new Set(entity.terminal);
  for (const s of states) if (terminal.has(s)) lines.push(`  ${id(s)} --> [*]`);

  const classed = states.filter((s) => highlightedStates.has(s));
  if (classed.length > 0) {
    lines.push(`  classDef ${HIGHLIGHT_CLASS} ${HIGHLIGHT_STYLE}`);
    lines.push(`  class ${classed.map(id).join(",")} ${HIGHLIGHT_CLASS}`);
  }
  return `${lines.join("\n")}\n`;
}

export function sortedTransitions(model: BehaviorModel): Transition[] {
  return [...model.transitions].sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * The states a diagram draws, in display order: declared states, then (by name) any state that
 * is only named as initial, terminal or in a transition.
 */
export function diagramStates(model: BehaviorModel): string[] {
  const { entity } = model;
  const extra = new Set<string>();
  const declared = new Set(entity.states);
  const noteExtra = (s: string) => {
    if (!declared.has(s)) extra.add(s);
  };
  noteExtra(entity.initial);
  for (const s of entity.terminal) noteExtra(s);
  for (const t of model.transitions) {
    noteExtra(t.to);
    if (t.from !== "*") for (const s of t.from) noteExtra(s);
  }
  return [...entity.states, ...[...extra].sort(compareStrings)];
}

/** The source states of `t`'s edges, in `states` order (`from: "*"` = every state). */
export function edgeSources(t: Transition, states: readonly string[]): string[] {
  if (t.from === "*") return [...states];
  const order = new Map(states.map((s, i) => [s, i]));
  return [...new Set(t.from)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * `name · actor[, actor] (guard, …)` followed by markers:
 * `(any state)`, timer, `⟳ idempotent`, one per effect, and `⚠ non-atomic`.
 * Guards are the transition's own `requires`; actor-implied guards are shown in the matrix.
 */
export function transitionLabel(t: Transition): string {
  let head = t.name;
  if (t.from === "*") head += " (any state)";
  head += ` · ${t.by.join(", ")}`;
  const guards = t.requires.map((g) => g.raw).sort(compareStrings);
  if (guards.length > 0) head += ` (${guards.join(", ")})`;

  const parts = [head];
  if (t.after !== undefined) parts.push(`after ${t.after}`);
  if (t.idempotent) parts.push("⟳ idempotent");
  for (const e of t.effects) parts.push(effectMarker(e));
  if (isNonAtomicOnce(t)) parts.push("⚠ non-atomic");
  return parts.join(" · ");
}

function effectMarker(e: EffectDecl): string {
  switch (e.multiplicity) {
    case "exactly-once":
      return `${e.name} ×1`;
    case "at-least-once":
      return `${e.name} ×n`;
    case "idempotent":
      return `${e.name} ⟳`;
  }
}

/** A non-atomic transition with an exactly-once effect: concurrent runs can duplicate the effect. */
export function isNonAtomicOnce(t: Transition): boolean {
  return !t.atomic && t.effects.some((e) => e.multiplicity === "exactly-once");
}
