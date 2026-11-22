import type { Trace, TraceAction, TraceState, TraceStep, WorkerState } from "@tsv/ir";
import type { StateStore } from "./explore";
import type { CheckContext } from "./properties/context";
import type { Action } from "./semantics";
import { concreteWorkers, representative } from "./symmetry";

function cloneState(s: TraceState): TraceState {
  return { status: s.status, effects: { ...s.effects }, workers: s.workers.map((w) => ({ ...w })) };
}

function moveWorker(state: TraceState, action: Action): WorkerState {
  const t = action.transition;
  const w = representative(state.workers, t.name, action.kind === "write" ? "checked" : "idle");
  if (!w) throw new Error(`checker: trace replay found no worker for ${action.kind} ${t.name}`);
  return w;
}

/**
 * Reconstructs the counterexample ending in `stateId` from the BFS parent chain.
 *
 * The chain gives the sequence of abstract actions; replaying it on concrete workers assigns
 * identities (always the lowest-numbered worker of the moved class, see `symmetry.ts`), true,
 * unsaturated effect counts, and each checked worker's `observed` status: the encoding does not
 * store it, so it is the status at the step where that worker read. Step 0 is the initial state
 * and has no action.
 */
export function buildTrace(
  ctx: CheckContext,
  actions: readonly Action[],
  store: StateStore,
  stateId: number,
  property: string,
  kind: Trace["kind"],
): Trace {
  const path: Action[] = [];
  for (let id = stateId; store.parent[id] !== -1; id = store.parent[id] as number) {
    path.push(actions[store.via[id] as number] as Action);
  }
  path.reverse();

  const { model, layout } = ctx;
  const effects: Record<string, number> = {};
  for (const e of layout.effects) effects[e.name] = 0;
  let state: TraceState = {
    status: model.entity.initial,
    effects,
    workers: concreteWorkers(layout.transitions),
  };
  const steps: TraceStep[] = [{ index: 0, state: cloneState(state) }];

  for (const action of path) {
    state = cloneState(state);
    const t = action.transition;
    const worker = moveWorker(state, action);
    if (action.kind === "read") {
      worker.phase = "checked";
      worker.observed = state.status;
    } else {
      worker.phase = "done";
      state.status = layout.states[t.to] as string;
      const fired = new Set(model.transitions[t.index]?.effects.map((e) => e.name));
      for (const name of fired) state.effects[name] = (state.effects[name] ?? 0) + 1;
    }
    const traceAction: TraceAction = { worker: worker.id, transition: t.name, kind: action.kind };
    if (action.kind !== "write") traceAction.outcome = "proceed";
    if (worker.duplicate) traceAction.duplicate = true;
    steps.push({ index: steps.length, action: traceAction, state });
  }

  return {
    behavior: model.name,
    entity: model.entity.name,
    model: model.origin,
    property,
    kind,
    steps,
  };
}
