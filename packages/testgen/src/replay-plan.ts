/**
 * Generation-time view of how `@tsv/runtime`'s `planFromTrace` will replay a counterexample.
 * Testgen may not import the runtime (doc 6 §2), so this mirrors the two parts it needs, kept in
 * step with `packages/runtime/src/plan.ts` and `sites.ts`:
 *
 * - the gate mapping (`mappingFromCode`), for the schedule comments in the generated file;
 * - the fast-forward rule (leading atomic actions and actions on unmapped transitions are seeded
 *   instead of replayed), to decide what the sidecar trace and the plan options must be.
 *
 * When the runtime's default fast-forward leaves something to replay and every replayed action
 * can be driven, the sidecar holds the trace unchanged and the test calls `planFromTrace(trace,
 * mapping)` (the shape of `packages/runtime/test/generated-shape.test.ts`). Otherwise (every
 * action is atomic, as in a duplicate webhook; or a step on a transition the test cannot call
 * sits after the first replayable one) testgen cuts the trace itself: the steps up to and
 * including the last undrivable action are fast-forwarded by seeding, everything after is
 * replayed, and the test plans with `{ fastForward: false }`.
 */
import type { BehaviorModel, CallSite, Trace, TraceState, TraceStep } from "@tsv/ir";

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
  /** The trace the sidecar holds (the original, or cut). */
  trace: Trace;
  /** false → the test passes `{ fastForward: false }` to `planFromTrace`. */
  fastForward: boolean;
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
    return view(trace, start, true, gates);
  }

  // Cut after the last action the test cannot drive (or replay everything).
  let cut = 1;
  steps.forEach((s, i) => {
    if (i > 0 && s.action && !drivable(s.action.transition)) cut = i + 1;
  });
  if (cut >= steps.length) {
    const a = action(steps.length - 1);
    return {
      ok: false,
      reason: `its last step (${a?.worker ?? "?"}: ${a?.transition ?? "?"}) is on a transition the generated test cannot call, so nothing is left to replay`,
    };
  }
  const busy = inFlight(cut);
  if (busy.length > 0) {
    return {
      ok: false,
      reason: `${busy.join(", ")} read the state before step ${cut} and write after it, so the steps before cannot be fast-forwarded by seeding`,
    };
  }
  const first = steps[cut - 1] as TraceStep;
  const cutTrace: Trace = {
    ...trace,
    steps: [{ index: first.index, state: first.state }, ...steps.slice(cut)],
  };
  const v = view(cutTrace, 1, false, gates);
  if (!v.ok) return v;
  return { ok: true, plan: { ...v.plan, skipped: steps.slice(1, cut) } };
}

function view(
  trace: Trace,
  start: number,
  fastForward: boolean,
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
      fastForward,
      skipped: trace.steps.slice(1, start),
      replayed: trace.steps.slice(start),
      seed: before.state,
      workers,
      schedule,
    },
  };
}
