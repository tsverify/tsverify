import {
  BUILTIN_PROPERTIES,
  compareStrings,
  type Trace,
  type TraceAction,
  type TraceStep,
} from "@tsverify/ir";
import { assignMermaidIds, escapeMermaidText } from "./mermaid-text";

/**
 * A counterexample as a numbered step list, one line per step:
 *
 *     step 0  status=draft
 *     step 4  refund#1 read → proceed  status=paid
 *     step 7  refund#2 write  status=refunded  stripe.refund=2  ✗ effect-multiplicity
 *
 * Each line shows the action (worker, kind, outcome), the resulting status, and only the effect
 * counts that changed in that step. The last step is marked with the violated property.
 */
export function traceToText(trace: Trace): string {
  const width = String(trace.steps.at(-1)?.index ?? 0).length;
  const lines = trace.steps.map((step, i) => {
    const parts = [`step ${String(step.index).padEnd(width)}`];
    if (step.action) parts.push(describeAction(step.action, true));
    parts.push(`status=${step.state.status}`);
    parts.push(...changedEffects(trace.steps[i - 1], step));
    if (i === trace.steps.length - 1) parts.push(`✗ ${trace.property}`);
    return parts.join("  ");
  });
  return `${lines.join("\n")}\n`;
}

export interface SequenceDiagramOptions {
  /** Display name of the entity participant, e.g. `Order`. The trace itself does not carry it. */
  entity?: string;
}

const ENTITY_ID = "Entity";

/**
 * A counterexample as a Mermaid `sequenceDiagram`: one participant per worker that acts (in
 * order of first action) plus the entity. Each action is an arrow from its worker to the
 * entity (a cross arrow when the state check rejected it), followed by a note when the status
 * or an effect count changed. A final note names the violated property.
 */
export function traceToSequenceDiagram(trace: Trace, options: SequenceDiagramOptions = {}): string {
  const workers: string[] = [];
  for (const step of trace.steps) {
    const w = step.action?.worker;
    if (w !== undefined && !workers.includes(w)) workers.push(w);
  }
  const ids = assignMermaidIds(workers, [ENTITY_ID]);
  const id = (w: string) => ids.get(w) ?? w;

  const lines = ["sequenceDiagram"];
  for (const w of workers) {
    lines.push(
      id(w) === w ? `  participant ${w}` : `  participant ${id(w)} as ${escapeMermaidText(w)}`,
    );
  }
  const entity = options.entity ?? trace.entity;
  lines.push(
    entity === ENTITY_ID
      ? `  participant ${ENTITY_ID}`
      : `  participant ${ENTITY_ID} as ${escapeMermaidText(entity)}`,
  );

  let lastWorker: string | undefined;
  trace.steps.forEach((step, i) => {
    const prev = trace.steps[i - 1];
    const changes: string[] = [];
    if (!prev || prev.state.status !== step.state.status)
      changes.push(`status=${step.state.status}`);
    changes.push(...changedEffects(prev, step));

    if (step.action) {
      const arrow = step.action.outcome === "rejected" ? "-x" : "->>";
      const text = escapeMermaidText(describeAction(step.action, false));
      lines.push(`  ${id(step.action.worker)}${arrow}${ENTITY_ID}: ${text}`);
      lastWorker = step.action.worker;
    }
    if (changes.length > 0) {
      lines.push(`  Note right of ${ENTITY_ID}: ${escapeMermaidText(changes.join(", "))}`);
    }
  });

  const over = lastWorker === undefined ? ENTITY_ID : `${id(lastWorker)},${ENTITY_ID}`;
  lines.push(`  Note over ${over}: ${escapeMermaidText(violationText(trace.property))}`);
  return `${lines.join("\n")}\n`;
}

/** `refund#1 read → proceed`. The transition is spelled out only if the worker id doesn't name it. */
function describeAction(action: TraceAction, withWorker: boolean): string {
  const namesTransition =
    action.worker === action.transition || action.worker.startsWith(`${action.transition}#`);
  const parts: string[] = [];
  if (withWorker) parts.push(action.worker);
  if (!namesTransition) parts.push(withWorker ? `(${action.transition})` : action.transition);
  parts.push(action.kind);
  if (action.outcome !== undefined) parts.push(`→ ${action.outcome}`);
  if (action.duplicate) parts.push("(duplicate delivery)");
  return parts.join(" ");
}

/** `name=count` for every effect whose count differs from the previous step (non-zero ones at step 0). */
function changedEffects(prev: TraceStep | undefined, step: TraceStep): string[] {
  const names = new Set([
    ...Object.keys(prev?.state.effects ?? {}),
    ...Object.keys(step.state.effects),
  ]);
  return [...names]
    .sort(compareStrings)
    .filter((n) => (step.state.effects[n] ?? 0) !== (prev?.state.effects[n] ?? 0))
    .map((n) => `${n}=${step.state.effects[n] ?? 0}`);
}

function violationText(property: string): string {
  if (!Object.hasOwn(BUILTIN_PROPERTIES, property)) return `✗ ${property}`;
  const { description } = BUILTIN_PROPERTIES[property as keyof typeof BUILTIN_PROPERTIES];
  return `✗ ${property}: ${description}`;
}
