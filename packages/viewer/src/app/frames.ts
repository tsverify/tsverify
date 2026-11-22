/**
 * Counterexample playback view-model: a trace becomes one frame per step (status, acting
 * transition, effect counters, violation), plus one swimlane per acting worker. Pure: data in,
 * data out, so it is tested without a browser.
 */
import {
  type BehaviorModel,
  BUILTIN_PROPERTIES,
  compareStrings,
  type Expr,
  type Finding,
  ruleProperty,
  type Trace,
  type TraceAction,
  type TraceActionKind,
  type WorkerPhase,
} from "@tsv/ir";
import { traceToText } from "@tsv/render";

export interface Frame {
  /** 0-based position in `Trace.steps` (what the slider moves). */
  position: number;
  /** `TraceStep.index`. */
  index: number;
  status: string;
  action?: TraceAction;
  /** The action in words, e.g. `refund#2 write`; `initial state` for step 0. */
  label: string;
  /** This step's line of `traceToText` (`@tsv/render`). */
  text: string;
  /** What the state diagram emphasises: the current status and the acting transition. */
  highlight: { states: string[]; transitions: string[] };
  effects: EffectCounter[];
  /** On the last frame only: the property the trace violates. */
  violation?: Violation;
}

export interface EffectCounter {
  name: string;
  count: number;
  /** Change since the previous frame. */
  delta: number;
  /** 1 for an effect declared exactly-once; absent when any count is allowed. */
  limit?: number;
  /** `count` exceeds `limit`. */
  over: boolean;
  /** The violated property is about this effect, and this is the violating frame. */
  violated: boolean;
}

export interface Violation {
  property: string;
  description: string;
  /** Effects the property is about (counters marked `violated`). */
  effects: string[];
}

export interface LaneCell {
  phase: WorkerPhase;
  /** Status the worker read (non-atomic transitions), once it has read one. */
  observed?: string;
  /** Present when this worker performs the frame's action. */
  acting?: { kind: TraceActionKind; outcome?: "proceed" | "rejected" };
}

export interface Swimlane {
  worker: string;
  transition: string;
  /** A duplicate delivery of an idempotent event. */
  duplicate: boolean;
  /** One per frame. */
  cells: LaneCell[];
}

export interface Playthrough {
  trace: Trace;
  frames: Frame[];
  /** Workers that act at least once, in order of their first action. */
  lanes: Swimlane[];
  /** Workers in the trace that never act (left out of `lanes`). */
  idleWorkers: string[];
}

/**
 * Frames and swimlanes for `trace`. `model` (the one the trace came from) supplies effect
 * multiplicities and rule expressions; `finding` (the one carrying the trace) names the effect a
 * built-in effect property is about.
 */
export function playthrough(trace: Trace, model?: BehaviorModel, finding?: Finding): Playthrough {
  const lines = traceToText(trace).trimEnd().split("\n");
  const effectNames = [...new Set(trace.steps.flatMap((s) => Object.keys(s.state.effects)))].sort(
    compareStrings,
  );
  const limits = effectLimits(model);
  const violation = violationOf(trace, model, finding);
  const lastPosition = trace.steps.length - 1;

  const frames = trace.steps.map((step, position): Frame => {
    const prev = trace.steps[position - 1];
    const isLast = position === lastPosition;
    const effects = effectNames.map((name): EffectCounter => {
      const count = step.state.effects[name] ?? 0;
      const limit = limits.get(name);
      const counter: EffectCounter = {
        name,
        count,
        delta: count - (prev?.state.effects[name] ?? 0),
        over: limit !== undefined && count > limit,
        violated: isLast && violation.effects.includes(name),
      };
      if (limit !== undefined) counter.limit = limit;
      return counter;
    });
    const frame: Frame = {
      position,
      index: step.index,
      status: step.state.status,
      label: step.action ? actionLabel(step.action) : "initial state",
      text: lines[position] ?? "",
      highlight: {
        states: [step.state.status],
        transitions: step.action ? [step.action.transition] : [],
      },
      effects,
    };
    if (step.action) frame.action = step.action;
    if (isLast) frame.violation = violation;
    return frame;
  });

  const order: string[] = [];
  const transitionOf = new Map<string, string>();
  for (const step of trace.steps) {
    for (const w of step.state.workers) transitionOf.set(w.id, w.transition);
    const actor = step.action?.worker;
    if (actor !== undefined && !order.includes(actor)) order.push(actor);
    if (step.action) transitionOf.set(step.action.worker, step.action.transition);
  }
  const lanes = order.map((worker): Swimlane => {
    let duplicate = false;
    const cells = trace.steps.map((step): LaneCell => {
      const state = step.state.workers.find((w) => w.id === worker);
      if (state?.duplicate || (step.action?.worker === worker && step.action.duplicate)) {
        duplicate = true;
      }
      const cell: LaneCell = { phase: state?.phase ?? "idle" };
      if (state?.observed !== undefined) cell.observed = state.observed;
      if (step.action?.worker === worker) {
        cell.acting = { kind: step.action.kind };
        if (step.action.outcome !== undefined) cell.acting.outcome = step.action.outcome;
      }
      return cell;
    });
    return { worker, transition: transitionOf.get(worker) ?? worker, duplicate, cells };
  });
  const idleWorkers = [...transitionOf.keys()].filter((w) => !order.includes(w));

  return { trace, frames, lanes, idleWorkers };
}

/** `refund#1 read → proceed`, naming the transition only when the worker id doesn't. */
export function actionLabel(action: TraceAction): string {
  const namesTransition =
    action.worker === action.transition || action.worker.startsWith(`${action.transition}#`);
  const parts = [action.worker];
  if (!namesTransition) parts.push(`(${action.transition})`);
  parts.push(action.kind);
  if (action.outcome !== undefined) parts.push(`→ ${action.outcome}`);
  if (action.duplicate) parts.push("(duplicate delivery)");
  return parts.join(" ");
}

/** Effects declared exactly-once anywhere in the model may fire at most once. */
function effectLimits(model: BehaviorModel | undefined): Map<string, number> {
  const limits = new Map<string, number>();
  for (const t of model?.transitions ?? []) {
    for (const e of t.effects) if (e.multiplicity === "exactly-once") limits.set(e.name, 1);
  }
  return limits;
}

function violationOf(
  trace: Trace,
  model: BehaviorModel | undefined,
  finding: Finding | undefined,
): Violation {
  const { property } = trace;
  if (Object.hasOwn(BUILTIN_PROPERTIES, property)) {
    const { description } = BUILTIN_PROPERTIES[property as keyof typeof BUILTIN_PROPERTIES];
    const subject = finding ? subjectOf(finding) : undefined;
    const effects =
      property !== "effect-multiplicity"
        ? []
        : subject !== undefined
          ? [subject]
          : overLimit(trace, model);
    return { property, description, effects };
  }
  const rule = model?.rules.find((r) => ruleProperty(r.name) === property);
  if (!rule) return { property, description: property, effects: [] };
  return {
    property,
    description: `${rule.name} (${rule.kind}: ${rule.source})`,
    effects: [...new Set(effectsIn(rule.expr))].sort(compareStrings),
  };
}

/** The `:<subject>` suffix of a finding id (see `Finding.id`), when there is one. */
function subjectOf(finding: Finding): string | undefined {
  const prefix = `${finding.category}:${finding.behavior ?? ""}:${finding.property ?? ""}:`;
  return finding.id.startsWith(prefix) ? finding.id.slice(prefix.length) || undefined : undefined;
}

function overLimit(trace: Trace, model: BehaviorModel | undefined): string[] {
  const limits = effectLimits(model);
  const last = trace.steps.at(-1)?.state.effects ?? {};
  return Object.keys(last)
    .filter((name) => (last[name] ?? 0) > (limits.get(name) ?? Number.POSITIVE_INFINITY))
    .sort(compareStrings);
}

function effectsIn(e: Expr): string[] {
  switch (e.type) {
    case "effect-count":
      return [e.effect];
    case "not":
      return effectsIn(e.expr);
    case "and":
    case "or":
    case "implies":
      return [...effectsIn(e.left), ...effectsIn(e.right)];
    default:
      return [];
  }
}
