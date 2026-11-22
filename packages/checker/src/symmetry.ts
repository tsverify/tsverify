import type { WorkerPhase, WorkerState } from "@tsverify/ir";

/**
 * Symmetry reduction over workers.
 *
 * Workers of the same transition in the same phase are interchangeable: no action, property or
 * rule can tell `refund#1` from `refund#2`. A state therefore stores only how many workers sit in
 * each class, never which worker is where. For one transition the classes are
 *
 *   idle      — not started
 *   checked   — non-atomic only: has read a status in `from`, write pending
 *   done      — finished; implied as `concurrency - idle - checked`, not stored
 *
 * The status a `checked` worker observed is not stored: the write never looks at it (that is the
 * check-then-act gap), so two states that differ only in what their checked workers observed
 * have exactly the same futures. Traces still show it, because `trace.ts` replays the actions
 * on concrete workers and records the status at each read.
 *
 * Concrete worker identities are only needed for traces. There, whenever an action moves "a
 * worker of class C", the canonical representative is the lowest-numbered worker in C.
 */
export interface WorkerClasses {
  /** Field offset of the idle count. */
  idle: number;
  /** Field offset of the `checked` count, or -1 for an atomic transition. */
  checked: number;
}

/**
 * Allocates the count fields for one transition's worker classes, starting at field `offset`.
 * Returns the classes and the next free offset.
 */
export function allocateWorkerClasses(
  atomic: boolean,
  offset: number,
): { classes: WorkerClasses; next: number } {
  let next = offset;
  const idle = next++;
  const checked = atomic ? -1 : next++;
  return { classes: { idle, checked }, next };
}

/** Worker ids are `<transition>#<n>` with n starting at 1. */
export function workerId(transition: string, n: number): string {
  return `${transition}#${n}`;
}

/** Concrete workers for traces, in canonical order (by transition, then number). */
export function concreteWorkers(
  transitions: readonly { name: string; idempotent: boolean; concurrency: number }[],
): WorkerState[] {
  const out: WorkerState[] = [];
  const sorted = [...transitions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const t of sorted) {
    for (let n = 1; n <= t.concurrency; n++) {
      const w: WorkerState = { id: workerId(t.name, n), transition: t.name, phase: "idle" };
      // Invocation #2 and later of an idempotent transition model redelivery of the same event.
      if (t.idempotent && n >= 2) w.duplicate = true;
      out.push(w);
    }
  }
  return out;
}

/**
 * The canonical representative of a worker class: the lowest-numbered worker of `transition` in
 * `phase`. `workers` must be in canonical order.
 */
export function representative(
  workers: readonly WorkerState[],
  transition: string,
  phase: WorkerPhase,
): WorkerState | undefined {
  return workers.find((w) => w.transition === transition && w.phase === phase);
}
