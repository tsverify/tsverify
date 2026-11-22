/**
 * `planFromTrace`: a model-checker counterexample (`ir.Trace`) → a schedule of code gates.
 *
 * The runtime must not depend on `@tsverify/ir` (it runs inside the user's test process), so the input
 * types here are **structural**: the subset of `ir.Trace` the planner reads. `test/ir-compat.test.ts`
 * proves an `ir.Trace` is assignable to `TraceInput`.
 */
import type { Step } from "./divergence";
import { UNTIL_DONE } from "./scheduler";

/** `ir.TraceActionKind`. */
export type ModelActionKind = "atomic" | "read" | "write";

/**
 * The subset of `ir.TraceStep` the planner reads. `kind` is a `ModelActionKind`, typed `string`
 * so that a trace imported from JSON (where TypeScript widens literals) is accepted as is; an
 * unknown kind fails with the "no code mapping" error.
 */
export interface TraceStepInput {
  index: number;
  action?: {
    worker: string;
    transition: string;
    kind: string;
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
   * entity status. Default `true`; `false` replays from the initial state (`replayFrom: 1`).
   * Sound only when nothing is in flight at that point (checked) and the status is all of the
   * relevant model state.
   */
  fastForward?: boolean;
  /**
   * Replay from this trace step on (its position in `trace.steps`, which is its `index` in a
   * checker trace) and fast-forward every step before it by seeding, whatever its kind: e.g. a
   * step on a transition the test cannot call. The steps from here on must all be mapped. Same
   * in-flight check as the default. Takes the place of `fastForward`; passing both is an error.
   */
  replayFrom?: number;
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
  /**
   * Effect counts the fast-forwarded prefix already produced, keyed by effect gate label. A rule
   * such as `count(effect stripe.refund) <= 1` is evaluated as seed count + calls in the replay.
   */
  seedEffects: Record<string, number>;
  /** The fast-forwarded actions, for the report. */
  skipped: { index: number; worker: string; transition: string; kind: string }[];
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

const ACTION_KINDS: ReadonlySet<string> = new Set<ModelActionKind>(["atomic", "read", "write"]);

function isActionKind(kind: string): kind is ModelActionKind {
  return ACTION_KINDS.has(kind);
}

/** Turns a counterexample into a schedule. Throws (with the fix) when it cannot. */
export function planFromTrace(
  trace: TraceInput,
  mapping: ReplayMapping,
  options: PlanOptions = {},
): ReplayPlan {
  const startIndex = replayStart(trace, mapping, options);
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
    const gates = isActionKind(a.kind) ? mapping.transitions[a.transition]?.[a.kind] : undefined;
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

  const byLabel = (count: (effect: string, n: number) => number): Record<string, number> => {
    const entries = Object.entries(last.effects).map(
      ([effect, n]) => [mapping.effects[effect] ?? effect, count(effect, n)] as const,
    );
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  };

  return {
    property: trace.property,
    startIndex,
    seedStatus: before.status,
    seedEffects: byLabel((effect) => before.effects[effect] ?? 0),
    skipped,
    workers,
    schedule,
    origins,
    expectedEffects: byLabel((effect, n) => n - (before.effects[effect] ?? 0)),
  };
}

/** The first replayed step: `replayFrom`, 1 without fast-forward, or after the default prefix. */
function replayStart(trace: TraceInput, mapping: ReplayMapping, options: PlanOptions): number {
  const length = trace.steps.length;
  const { replayFrom } = options;
  if (replayFrom !== undefined) {
    if (options.fastForward !== undefined) {
      throw new Error("planFromTrace: pass either `fastForward` or `replayFrom`, not both");
    }
    if (!Number.isInteger(replayFrom) || replayFrom < 1 || replayFrom >= length) {
      throw new Error(
        `planFromTrace: replayFrom ${replayFrom} is not a step of the trace for ${trace.property} ` +
          `(1 to ${length - 1}; step 0 is the initial state)`,
      );
    }
    return replayFrom;
  }
  if (options.fastForward === false) {
    if (length < 2) throw new Error(`trace for ${trace.property} has no actions to replay`);
    return 1;
  }

  const mapped = (t: string) => Object.hasOwn(mapping.transitions, t);
  let start = 1;
  while (start < length) {
    const a = trace.steps[start]?.action;
    if (!a || (a.kind !== "atomic" && mapped(a.transition))) break;
    start++;
  }
  if (start >= length) {
    throw new Error(
      `trace for ${trace.property} has nothing to replay: every action is atomic or on an ` +
        `unmapped transition (mapped: ${Object.keys(mapping.transitions).sort().join(", ") || "none"}); ` +
        "pass `replayFrom` to choose the first replayed step",
    );
  }
  return start;
}
