/**
 * `planFromTrace`: a model-checker counterexample (`ir.Trace`) → a schedule of code gates.
 *
 * The runtime must not depend on `@tsv/ir` (it runs inside the user's test process), so the input
 * types here are **structural**: the subset of `ir.Trace` the planner reads. `test/ir-compat.test.ts`
 * proves an `ir.Trace` is assignable to `TraceInput`.
 */
import type { Step } from "./divergence";
import { UNTIL_DONE } from "./scheduler";

/** `ir.TraceActionKind`. */
export type ModelActionKind = "atomic" | "read" | "write";

/** The subset of `ir.TraceStep` the planner reads. */
export interface TraceStepInput {
  index: number;
  action?: {
    worker: string;
    transition: string;
    kind: ModelActionKind;
    duplicate?: boolean;
  };
  state: {
    status: string;
    effects: Readonly<Record<string, number>>;
    workers: readonly { id: string; transition: string; phase: string }[];
  };
}

/** The subset of `ir.Trace` the planner reads. */
export interface TraceInput {
  property: string;
  steps: readonly TraceStepInput[];
}

/**
 * Model action → code gates. `transitions[t][kind]` lists the **sync** gates (read / commit call
 * paths) that one model action of that kind corresponds to, in code order. Transparent gates
 * (transactions, effects) are passed automatically and don't need to be listed. Build it from the
 * extractor's `CodeSites` with `mappingFromCode`.
 */
export interface ReplayMapping {
  transitions: Readonly<Record<string, Partial<Record<ModelActionKind, readonly string[]>>>>;
  /** Spec effect name → effect gate label, e.g. `stripe.refund` → `stripe.refunds.create`. */
  effects: Readonly<Record<string, string>>;
}

export interface PlanOptions {
  /**
   * Replace the leading atomic actions (and actions on unmapped transitions) by seeding the
   * entity status. Default `true`. Sound only when nothing is in flight at that point (checked)
   * and the status is all of the relevant model state.
   */
  fastForward?: boolean;
}

export interface PlannedWorker {
  /** Trace worker id, e.g. `refund#1`; used as the scheduler worker id. */
  id: string;
  transition: string;
  /** A duplicate delivery of an idempotent event (webhooks). */
  duplicate?: boolean;
}

export interface ReplayPlan {
  property: string;
  /** Index of the first replayed trace step. Earlier steps are fast-forwarded by seeding. */
  startIndex: number;
  /** Entity status to seed: the model state just before `startIndex`. */
  seedStatus: string;
  /** The fast-forwarded actions, for the report. */
  skipped: { index: number; worker: string; transition: string; kind: ModelActionKind }[];
  /** Workers to spawn, in order of first appearance. */
  workers: PlannedWorker[];
  schedule: Step[];
  /** For each schedule step, the trace step index it came from (-1 for the trailing until-done). */
  origins: number[];
  /**
   * Effect calls the model predicts during the replayed part, keyed by effect gate label and
   * sorted by label.
   */
  expectedEffects: Record<string, number>;
}

/** Turns a counterexample into a schedule. Throws (with the fix) when it cannot. */
export function planFromTrace(
  trace: TraceInput,
  mapping: ReplayMapping,
  options: PlanOptions = {},
): ReplayPlan {
  const mapped = (t: string) => Object.hasOwn(mapping.transitions, t);
  const fastForward = options.fastForward ?? true;

  let startIndex = 1;
  while (fastForward && startIndex < trace.steps.length) {
    const a = trace.steps[startIndex]?.action;
    if (!a || (a.kind !== "atomic" && mapped(a.transition))) break;
    startIndex++;
  }
  if (startIndex >= trace.steps.length) {
    throw new Error(
      `trace for ${trace.property} has nothing to replay: every action is atomic or on an ` +
        `unmapped transition (mapped: ${Object.keys(mapping.transitions).sort().join(", ") || "none"})`,
    );
  }
  const before = trace.steps[startIndex - 1]?.state;
  const last = trace.steps.at(-1)?.state;
  if (!before || !last) throw new Error("trace has no initial state");

  // Fast-forwarding the prefix by seeding is only sound if nothing is in flight at that point.
  const inFlight = before.workers.filter((w) => w.phase === "checked");
  if (inFlight.length > 0) {
    throw new Error(
      `cannot fast-forward to step ${startIndex}: ${inFlight.map((w) => w.id).join(", ")} ` +
        "read the state in the prefix and has not written yet",
    );
  }

  const skipped: ReplayPlan["skipped"] = [];
  for (const step of trace.steps.slice(1, startIndex)) {
    const a = step.action;
    if (a)
      skipped.push({ index: step.index, worker: a.worker, transition: a.transition, kind: a.kind });
  }

  const schedule: Step[] = [];
  const origins: number[] = [];
  const workers: PlannedWorker[] = [];
  for (const step of trace.steps.slice(startIndex)) {
    const a = step.action;
    if (!a) continue;
    const gates = mapping.transitions[a.transition]?.[a.kind];
    if (!gates) {
      throw new Error(
        `trace step ${step.index} (${a.worker}: ${a.transition}.${a.kind}) has no code mapping; ` +
          `add ${JSON.stringify(a.transition)}.${a.kind} to the replay mapping`,
      );
    }
    if (!workers.some((w) => w.id === a.worker)) {
      workers.push({
        id: a.worker,
        transition: a.transition,
        ...(a.duplicate ? { duplicate: true } : {}),
      });
    }
    for (const gate of gates) {
      schedule.push([a.worker, gate]);
      origins.push(step.index);
    }
  }
  for (const w of workers) {
    schedule.push([w.id, UNTIL_DONE]);
    origins.push(-1);
  }

  const expectedEffects: Record<string, number> = {};
  const deltas = Object.entries(last.effects).map(
    ([effect, count]) =>
      [mapping.effects[effect] ?? effect, count - (before.effects[effect] ?? 0)] as const,
  );
  deltas.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [label, delta] of deltas) expectedEffects[label] = delta;

  return {
    property: trace.property,
    startIndex,
    seedStatus: before.status,
    skipped,
    workers,
    schedule,
    origins,
    expectedEffects,
  };
}
