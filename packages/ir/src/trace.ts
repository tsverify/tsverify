import type { ModelOrigin } from "./model";

/**
 * Lifecycle of one invocation of a transition inside the checker.
 * - idle:     not started
 * - checked:  (non-atomic only) has read a state in `from`, write pending
 * - done:     completed its write
 * - rejected: read a state outside `from`; no effect
 */
export type WorkerPhase = "idle" | "checked" | "done" | "rejected";

export interface WorkerState {
  /** Stable id within a trace, e.g. `refund#1`. */
  id: string;
  transition: string;
  phase: WorkerPhase;
  /** Status this worker observed at read time (non-atomic transitions). */
  observed?: string;
  /** true when this invocation is a duplicate delivery of an idempotent event. */
  duplicate?: boolean;
}

export interface TraceState {
  status: string;
  effects: Record<string, number>;
  workers: WorkerState[];
}

export type TraceActionKind = "atomic" | "read" | "write";

export interface TraceAction {
  worker: string;
  transition: string;
  kind: TraceActionKind;
  /** For `read` and `atomic`: whether the state check passed. */
  outcome?: "proceed" | "rejected";
  duplicate?: boolean;
}

export interface TraceStep {
  index: number;
  /** Absent for the initial state (index 0). */
  action?: TraceAction;
  state: TraceState;
}

/** A counterexample: the shortest found sequence of steps that violates a property. */
export interface Trace {
  behavior: string;
  /** Entity name, e.g. `Order` (for labelling diagrams without the model at hand). */
  entity: string;
  model: ModelOrigin;
  /** Built-in property id or `rule:<rule name>`. */
  property: string;
  kind: "invariant" | "liveness";
  steps: TraceStep[];
}
