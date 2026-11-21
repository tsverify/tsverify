import type { Trace, TraceActionKind } from "@tsv/ir";
import { type Step, UNTIL_DONE } from "./scheduler";

/**
 * What a replay needs to turn model actions into code gates. In `tsv` this comes from the
 * extractor (`Transition.sites`) and the spec's `bindings`. See README "What CodeSites must contain".
 */
export interface ReplayMapping {
  /** Model transition → the sync gates each model action kind corresponds to, in code order. */
  transitions: Record<string, Partial<Record<TraceActionKind, string[]>>>;
  /** Model effect name → effect gate label (`Bindings.effects`), e.g. `stripe.refund` → `stripe.refunds.create`. */
  effects: Record<string, string>;
}

export interface TraceReplayPlan {
  property: string;
  /** Index of the first replayed trace step. Earlier steps are fast-forwarded by seeding. */
  startIndex: number;
  /** Entity status to seed: the model state just before `startIndex`. */
  seedStatus: string;
  /** Workers to spawn (model worker ids), in order of first appearance. */
  workers: { id: string; transition: string }[];
  schedule: Step[];
  /** For each schedule step, the trace step index it came from (-1 for the trailing until-done). */
  origins: number[];
  /** Effect calls the model predicts during the replayed part, keyed by effect gate label. */
  expectedEffects: Record<string, number>;
}

/**
 * How a replay outcome maps onto findings (doc 3, Part C "How the outcomes combine"):
 * - `confirmed`: schedule followed and the property is violated in the real code.
 * - `confirmed-divergent`: the code diverged from the schedule but still violated the property
 *   (after draining). A real bug, reached by a different interleaving; report the divergence too.
 * - `replay-disagrees`: the property holds. Either the code is safer than the trace (diverged,
 *   e.g. `blocked` by a lock), or the schedule was followed but the effect never happened
 *   (mapping or instrumentation gap). A warning with the divergence attached, never dropped.
 */
export type ReplayVerdict = "confirmed" | "confirmed-divergent" | "replay-disagrees";

export function replayVerdict(r: { followed: boolean; violated: boolean }): ReplayVerdict {
  if (r.violated) return r.followed ? "confirmed" : "confirmed-divergent";
  return "replay-disagrees";
}

export function planFromTrace(trace: Trace, mapping: ReplayMapping): TraceReplayPlan {
  const replayable = (t: string) => Object.hasOwn(mapping.transitions, t);
  const startIndex = trace.steps.findIndex((s) => s.action && replayable(s.action.transition));
  if (startIndex < 0) {
    throw new Error(
      `trace for ${trace.property} has no action on a mapped transition (mapped: ${Object.keys(mapping.transitions).join(", ")})`,
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

  const schedule: Step[] = [];
  const origins: number[] = [];
  const workers: { id: string; transition: string }[] = [];
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
      workers.push({ id: a.worker, transition: a.transition });
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
  for (const [effect, count] of Object.entries(last.effects)) {
    const label = mapping.effects[effect] ?? effect;
    expectedEffects[label] = count - (before.effects[effect] ?? 0);
  }

  return {
    property: trace.property,
    startIndex,
    seedStatus: before.status,
    workers,
    schedule,
    origins,
    expectedEffects,
  };
}
