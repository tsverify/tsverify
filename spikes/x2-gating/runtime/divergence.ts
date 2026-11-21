/**
 * Why a schedule could not be followed. A replay that silently diverges is worse than useless,
 * so every way of falling off the schedule has its own kind and a precise message.
 */
export type DivergenceKind =
  /** The schedule names a worker that was never spawned, or a gate no instrument defines. */
  | "invalid-schedule"
  /** The worker settled (returned) before it reached the gate the step names. */
  | "finished-early"
  /** The worker threw before it reached the gate the step names. */
  | "threw"
  /** The worker's next sync gate is not the one the step names. */
  | "different-gate"
  /** The worker is waiting for a resource (e.g. a transaction lock) held by another worker. */
  | "blocked"
  /** Every unfinished worker is waiting, or the wait-for chain is a cycle. */
  | "deadlock"
  /** The running worker neither reached a gate nor settled within the step timeout. */
  | "timeout"
  /** A worker called a gate while it was not the running worker (Promise.all, fire-and-forget). */
  | "stray-gate";

export interface WorkerSnapshot {
  id: string;
  /** Human-readable state, e.g. `parked at "db.orders.save"`. */
  state: string;
  /** Gates this worker has passed, in order. */
  passed: string[];
}

export interface DivergenceDetails {
  kind: DivergenceKind;
  /** 0-based index of the step that could not be followed; -1 for `drain()`. */
  stepIndex: number;
  /** The step itself, e.g. `["w2", "db.orders.get"]`, or `["*", "drain"]`. */
  step: readonly [string, string];
  /** Number of steps in the schedule being played (0 for `drain()`). */
  stepCount: number;
  worker: string;
  /** The gate (or `until-done`) the step was heading for. */
  expected: string;
  /** What happened instead: the gate actually hit, the resource waited on, the error message. */
  actual: string;
  /** One-paragraph explanation. */
  explanation: string;
  workers: WorkerSnapshot[];
  /** The steps completed before this one. */
  completed: readonly (readonly [string, string])[];
  /** The thrown error, for `threw`. */
  cause?: unknown;
}

function q(s: string): string {
  return JSON.stringify(s);
}

export function formatStep(step: readonly [string, string]): string {
  return `[${q(step[0])}, ${q(step[1])}]`;
}

export class ReplayDivergence extends Error {
  readonly details: DivergenceDetails;

  constructor(details: DivergenceDetails) {
    super(ReplayDivergence.format(details), details.cause ? { cause: details.cause } : undefined);
    this.name = "ReplayDivergence";
    this.details = details;
  }

  get kind(): DivergenceKind {
    return this.details.kind;
  }

  static format(d: DivergenceDetails): string {
    const where =
      d.stepIndex < 0
        ? "while draining"
        : `at step ${d.stepIndex + 1}/${d.stepCount} ${formatStep(d.step)}`;
    const lines = [`Replay diverged ${where}: ${d.kind}`, `  ${d.explanation}`, "Workers:"];
    const width = Math.max(...d.workers.map((w) => w.id.length), 2);
    for (const w of d.workers) {
      const passed = w.passed.length ? `   passed: ${w.passed.join(" → ")}` : "";
      lines.push(`  ${w.id.padEnd(width)}  ${w.state}${passed}`);
    }
    if (d.completed.length) {
      lines.push("Completed steps:");
      d.completed.forEach((s, i) => {
        lines.push(`  ${i + 1}. ${formatStep(s)}`);
      });
    } else {
      lines.push("Completed steps: none");
    }
    return lines.join("\n");
  }
}
