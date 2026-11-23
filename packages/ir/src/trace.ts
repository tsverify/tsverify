import type { SourceLocation } from "./location";
import type { ModelOrigin } from "./model";

/**
 * Lifecycle of one invocation of a transition inside the checker.
 * - idle:     not started
 * - checked:  (non-atomic only) has read a state in `from`, write pending
 * - done:     completed its write
 * - rejected: read a state outside `from`; no effect. Reserved for traces observed from real
 *             runs (replay): the built-in checker treats failed attempts as no-ops and never
 *             produces this phase.
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
  /**
   * For `read` and `atomic`: whether the state check passed. The built-in checker only emits
   * enabled actions, so it never produces `"rejected"`; replayed real runs may.
   */
  outcome?: "proceed" | "rejected";
  duplicate?: boolean;
  /**
   * Code models: the write a transition named `t~2`, `t~3`, … stands for (a spec transition's
   * second, third, … write of its `to`). Those names are internal: a trace shows the spec
   * transition and this location instead.
   */
  at?: SourceLocation;
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
