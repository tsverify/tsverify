import type { Trace, TraceAction, TraceState, WorkerState } from "@tsv/ir";

/**
 * `ir.Trace` → ITF JSON, the Informal Trace Format of Apalache (ADR-015) that Quint also reads
 * and writes. Encoding:
 *
 *   status   string
 *   effects  {"#map": [[name, {"#bigint": "n"}], …]}               sorted by name
 *   workers  {"#map": [[id, {transition, phase, observed, duplicate}], …]}  in trace order
 *            observed is a Quint Option: {"tag": "Some", "value": s} | {"tag": "None", …}
 *   action   Quint variant: Init (step 0) | Atomic | Read | Write, with value
 *            {worker, transition, duplicate}
 *
 * Integers always use `#bigint`, as Quint emits them. The result is plain JSON data.
 */
export function toItf(trace: Trace): Record<string, unknown> {
  return {
    "#meta": {
      format: "ITF",
      "format-description": "https://apalache-mc.org/docs/adr/015adr-trace.html",
      description: `tsv counterexample: ${trace.property} in ${trace.behavior}`,
      behavior: trace.behavior,
      model: trace.model,
      property: trace.property,
      kind: trace.kind,
    },
    vars: ["status", "effects", "workers", "action"],
    states: trace.steps.map((step) => ({
      "#meta": { index: step.index },
      ...itfState(step.state),
      action: itfAction(step.action),
    })),
  };
}

function unit(): { "#tup": [] } {
  return { "#tup": [] };
}

function bigint(n: number): { "#bigint": string } {
  return { "#bigint": String(n) };
}

function itfState(state: TraceState): Record<string, unknown> {
  const effects = Object.keys(state.effects)
    .sort()
    .map((name) => [name, bigint(state.effects[name] ?? 0)]);
  return {
    status: state.status,
    effects: { "#map": effects },
    workers: { "#map": state.workers.map((w) => [w.id, itfWorker(w)]) },
  };
}

function itfWorker(w: WorkerState): Record<string, unknown> {
  return {
    transition: w.transition,
    phase: w.phase,
    observed:
      w.observed === undefined
        ? { tag: "None", value: unit() }
        : { tag: "Some", value: w.observed },
    duplicate: w.duplicate === true,
  };
}

const TAGS: Record<TraceAction["kind"], string> = {
  atomic: "Atomic",
  read: "Read",
  write: "Write",
};

function itfAction(action: TraceAction | undefined): Record<string, unknown> {
  if (!action) return { tag: "Init", value: unit() };
  return {
    tag: TAGS[action.kind],
    value: {
      worker: action.worker,
      transition: action.transition,
      duplicate: action.duplicate === true,
    },
  };
}
