/**
 * Generation-time view of how `@tsverify/runtime`'s `planFromTrace` will replay a counterexample.
 * Testgen may not import the runtime, so this mirrors the two parts it needs, kept in
 * step with `packages/runtime/src/plan.ts` and `sites.ts` (`test/runtime-cross-check.test.ts`
 * checks both against the real runtime):
 *
 * - the gate mapping (`mappingFromCode`), for the schedule comments in the generated file;
 * - the fast-forward rule (leading atomic actions and actions on unmapped transitions are seeded
 *   instead of replayed), to decide which plan options the test passes.
 *
 * The sidecar always holds the trace unchanged. When the runtime's default fast-forward leaves
 * something to replay and every replayed action can be driven, the test calls
 * `planFromTrace(trace, mapping)` (the shape of `packages/runtime/test/generated-shape.test.ts`).
 * Otherwise (every action is atomic, as in a duplicate webhook; or a step on a transition the test
 * cannot call sits after the first replayable one) the test passes `{ replayFrom: i }`: the steps
 * up to and including the last undrivable action are fast-forwarded by seeding, everything after
 * is replayed (from the initial state when every action is drivable).
 */
import type { BehaviorModel, CallSite, Trace, TraceState, TraceStep } from "@tsverify/ir";

export interface Gates {
  read: string[];
  write: string[];
  atomic: string[];
}

/** `mappingFromCode(code).transitions`: model action kind → sync gates. */
export function gateMapping(code: BehaviorModel): Map<string, Gates> {
  const out = new Map<string, Gates>();
  for (const t of code.transitions) {
    const sites = t.sites;
    if (!sites || sites.specTransition !== t.name) continue;
    const seen = new Map<string, number>();
    const upTo = (site: CallSite | undefined): string[] => {
      if (!site) return [];
      const already = seen.get(site.gate) ?? 0;
      const count = Math.max(1, site.occurrence + 1 - already);
      seen.set(site.gate, already + count);
      return Array.from({ length: count }, () => site.gate);
    };
    const read = upTo(sites.read);
    const write = upTo(sites.commit);
    out.set(t.name, { read, write, atomic: [...read, ...write] });
  }
  return out;
}

export interface ReplayPlanView {
  /** The trace the sidecar holds (the finding's, unchanged). */
  trace: Trace;
  /**
   * The test passes `{ replayFrom }` to `planFromTrace` (the first replayed step); undefined: the
   * runtime's default fast-forward.
   */
  replayFrom?: number;
  /** Fast-forwarded steps of the original trace (seeded, not replayed). */
  skipped: TraceStep[];
  /** Replayed steps of the original trace. */
  replayed: TraceStep[];
  /** Model state the replay starts from. */
  seed: TraceState;
  /** Workers spawned, in order of first appearance. */
  workers: { id: string; transition: string; duplicate?: boolean }[];
  /** The schedule's mapped steps: worker, gate, trace step index. */
  schedule: { worker: string; gate: string; step: number }[];
}

export type ReplayPlanResult = { ok: true; plan: ReplayPlanView } | { ok: false; reason: string };

/**
 * @param gates the code's gate mapping (`gateMapping`)
 * @param drivable whether the generated test can spawn a worker for a transition
 */
export function planReplay(
  trace: Trace,
  gates: ReadonlyMap<string, Gates>,
  drivable: (transition: string) => boolean,
): ReplayPlanResult {
  const steps = trace.steps;
  const action = (i: number) => steps[i]?.action;
  const usable = (from: number) =>
    steps.slice(from).every((s) => s.action === undefined || drivable(s.action.transition));
  const inFlight = (i: number) =>
    (steps[i - 1]?.state.workers ?? []).filter((w) => w.phase === "checked").map((w) => w.id);

  // The runtime's default fast-forward.
  let start = 1;
  while (start < steps.length) {
    const a = action(start);
    if (!a || (a.kind !== "atomic" && gates.has(a.transition))) break;
    start++;
  }
  if (start < steps.length && inFlight(start).length === 0 && usable(start)) {
    return view(trace, start, undefined, gates);
  }

  // Replay from after the last action the test cannot drive (or everything).
  let from = 1;
  steps.forEach((s, i) => {
    if (i > 0 && s.action && !drivable(s.action.transition)) from = i + 1;
  });
  if (from >= steps.length) {
    const a = action(steps.length - 1);
    return {
      ok: false,
      reason: `its last step (${a?.worker ?? "?"}: ${a?.transition ?? "?"}) is on a transition the generated test cannot call, so nothing is left to replay`,
    };
  }
  const busy = inFlight(from);
  if (busy.length > 0) {
    return {
      ok: false,
      reason: `${busy.join(", ")} read the state before step ${from} and write after it, so the steps before cannot be fast-forwarded by seeding`,
    };
  }
  return view(trace, from, from, gates);
}

function view(
  trace: Trace,
  start: number,
  replayFrom: number | undefined,
  gates: ReadonlyMap<string, Gates>,
): ReplayPlanResult {
  const before = trace.steps[start - 1];
  if (!before) return { ok: false, reason: "the trace has no initial state" };
  const workers: ReplayPlanView["workers"] = [];
  const schedule: ReplayPlanView["schedule"] = [];
  for (const step of trace.steps.slice(start)) {
    const a = step.action;
    if (!a) continue;
    const g = gates.get(a.transition)?.[a.kind];
    if (g === undefined) {
      return { ok: false, reason: `step ${step.index} (${a.transition}) has no code mapping` };
    }
    if (!workers.some((w) => w.id === a.worker)) {
      workers.push({
        id: a.worker,
        transition: a.transition,
        ...(a.duplicate ? { duplicate: true } : {}),
      });
    }
    for (const gate of g) schedule.push({ worker: a.worker, gate, step: step.index });
  }
  return {
    ok: true,
    plan: {
      trace,
      ...(replayFrom === undefined ? {} : { replayFrom }),
      skipped: trace.steps.slice(1, start),
      replayed: trace.steps.slice(start),
      seed: before.state,
      workers,
      schedule,
    },
  };
}
