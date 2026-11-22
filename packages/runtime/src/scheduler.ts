/**
 * The replay scheduler: workers, gates, `play(schedule)`. See README "Scheduler semantics".
 *
 * Invariant: at most one worker is `running` at any time, and a worker only starts running when a
 * step (or `drain`) resumes it. A step ends on an event (the worker parks at a gate, waits for a
 * lock, or settles), never on a count of microtasks, so a schedule always produces the same run.
 *
 * The worker lifecycle is specified in `scheduler.behavior.yaml`; each status change below lives
 * in its own method (`start`, `park`, `pass`, `markWaiting`, `markReady`, `wake`, `complete`,
 * `fail`), which that file links to.
 */
import { currentWorkerContext, runInWorker } from "./context";
import {
  type DivergenceDetails,
  type DivergenceKind,
  ReplayDivergence,
  type Step,
  type WorkerSnapshot,
} from "./divergence";
import { type GateEvent, type GateKind, GateRegistry } from "./gates";
import { type LockHost, SchedLock } from "./lock";
import { errorMessage, preview } from "./preview";

// Captured at import, before any test can install fake timers: the step timeout must stay real.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;

/** Step target meaning "run this worker until its function settles (returns or throws)". */
export const UNTIL_DONE = "until-done";

export type Schedule = readonly Step[];

/**
 * - `spawned`: registered, not started
 * - `running`: its code is executing (at most one worker at a time)
 * - `parked`: called an instrumented method and is suspended *before* the call does anything
 * - `waiting`: blocked on a lock held by another worker; cannot be resumed
 * - `ready`: was waiting, now holds the lock, but has not run since
 * - `done` / `failed`: its function returned / threw
 */
export type WorkerStatus =
  | "spawned"
  | "running"
  | "parked"
  | "waiting"
  | "ready"
  | "done"
  | "failed";

export interface Worker {
  readonly id: string;
  readonly fn: () => unknown;
  status: WorkerStatus;
  /** `parked`: the gate reached and the call's arguments. */
  gate: string | undefined;
  args: readonly unknown[];
  /** `waiting` / `ready`: the lock. */
  resource: string | undefined;
  /** `parked` / `ready`: lets the suspended call continue. */
  wake: (() => void) | undefined;
  /** `done` / `failed`. */
  value: unknown;
  error: unknown;
  /** Gates passed, in order. */
  passed: string[];
}

export interface EffectCall {
  /** Position in the run, shared with `GateEvent.seq`. */
  seq: number;
  /** Worker id, or `null` when called outside any worker (test setup). */
  worker: string | null;
  /** Effect gate label, e.g. `stripe.refunds.create`. */
  effect: string;
  args: readonly unknown[];
}

export type Outcome =
  | { status: "done"; value: unknown }
  | { status: "failed"; error: unknown }
  | { status: "unfinished"; state: string };

export interface PlayReport {
  /** Steps played by this call. */
  steps: number;
  /** Every gate passed so far, across all workers, in order. */
  log: GateEvent[];
}

export type PlayOutcome =
  | { followed: true; report: PlayReport }
  | { followed: false; divergence: ReplayDivergence };

export interface SchedulerOptions {
  /** Max time a resumed worker may run before reaching a gate or settling. Default 2000 ms. */
  stepTimeoutMs?: number;
}

interface StepContext {
  index: number;
  step: Step;
  stepCount: number;
}

const RESUMABLE: ReadonlySet<WorkerStatus> = new Set(["spawned", "parked", "ready"]);

export class Scheduler implements LockHost {
  private readonly stepTimeoutMs: number;
  private readonly gates = new GateRegistry();
  private readonly resetHooks: (() => void)[] = [];
  private generation = 0;
  private workers = new Map<string, Worker>();
  private locks = new Map<string, SchedLock>();
  private log: GateEvent[] = [];
  private effectLog: EffectCall[] = [];
  private strays: string[] = [];
  private completed: Step[] = [];
  private seq = 0;
  private changed = signal();

  constructor(options: SchedulerOptions = {}) {
    this.stepTimeoutMs = options.stepTimeoutMs ?? 2000;
  }

  // ------------------------------------------------------------------ test API

  /** Register a worker. It does not start until a step (or `drain`) schedules it. */
  spawn(id: string, fn: () => unknown): void {
    if (this.workers.has(id)) throw new Error(`worker ${JSON.stringify(id)} already spawned`);
    this.workers.set(id, {
      id,
      fn,
      status: "spawned",
      gate: undefined,
      args: [],
      resource: undefined,
      wake: undefined,
      value: undefined,
      error: undefined,
      passed: [],
    });
  }

  /** Follow `schedule` step by step. Throws `ReplayDivergence` if it cannot be followed. */
  async play(schedule: Schedule): Promise<PlayReport> {
    this.validate(schedule);
    for (const [index, step] of schedule.entries()) {
      await this.runStep({ index, step, stepCount: schedule.length });
      this.completed.push(step);
    }
    return { steps: schedule.length, log: [...this.log] };
  }

  /** Like `play`, but returns the divergence instead of throwing it. */
  async tryPlay(schedule: Schedule): Promise<PlayOutcome> {
    try {
      return { followed: true, report: await this.play(schedule) };
    } catch (e) {
      if (e instanceof ReplayDivergence) return { followed: false, divergence: e };
      throw e;
    }
  }

  /**
   * Run every unfinished worker to completion in a fixed order: repeatedly resume the first
   * worker (in spawn order) that can run. Throws `deadlock` if only waiting workers remain.
   */
  async drain(): Promise<void> {
    const ctx: StepContext = { index: -1, step: ["*", "drain"], stepCount: 0 };
    for (;;) {
      const next = [...this.workers.values()].find((w) => RESUMABLE.has(w.status));
      if (!next) {
        const waiting = [...this.workers.values()].filter((w) => w.status === "waiting");
        const first = waiting[0];
        if (!first) return;
        throw this.diverge(ctx, "deadlock", first, UNTIL_DONE, this.resourceOf(first), [
          "every unfinished worker is waiting:",
          `${waiting.map((w) => `${w.id} on ${this.resourceOf(w)}`).join(", ")}.`,
        ]);
      }
      this.resume(next);
      await this.settle(ctx, next, UNTIL_DONE);
    }
  }

  /** Discard all workers, logs and locks; reset every fake (stores go back to their seed). */
  reset(): void {
    this.generation += 1;
    this.workers = new Map();
    this.locks = new Map();
    this.log = [];
    this.effectLog = [];
    this.strays = [];
    this.completed = [];
    this.seq = 0;
    for (const hook of this.resetHooks) hook();
  }

  outcome(id: string): Outcome {
    const w = this.workers.get(id);
    if (!w) throw new Error(`unknown worker ${JSON.stringify(id)}`);
    if (w.status === "done") return { status: "done", value: w.value };
    if (w.status === "failed") return { status: "failed", error: w.error };
    return { status: "unfinished", state: this.describe(w) };
  }

  /** Every gate passed so far, in order. */
  gateLog(): GateEvent[] {
    return [...this.log];
  }

  /** Recorded effect calls, optionally filtered by label (e.g. `stripe.refunds.create`). */
  effects(label?: string): EffectCall[] {
    return this.effectLog.filter((e) => label === undefined || e.effect === label);
  }

  /** Every worker's state and passed gates, in spawn order. */
  snapshot(): WorkerSnapshot[] {
    return [...this.workers.values()].map((w) => ({
      id: w.id,
      state: this.describe(w),
      passed: [...w.passed],
    }));
  }

  /** Every gate label defined by this scheduler's instruments, in definition order. */
  knownGates(): string[] {
    return this.gates.labels();
  }

  // ------------------------------------------------------------------ instrument API

  defineGate(label: string, kind: GateKind, owner: string): void {
    this.gates.define(label, kind, owner);
  }

  /** Runs on every `reset()`, in registration order. Instruments clear and re-seed here. */
  onReset(hook: () => void): void {
    this.resetHooks.push(hook);
  }

  currentWorkerId(): string | undefined {
    const ctx = currentWorkerContext();
    if (!ctx || ctx.owner !== this || ctx.generation !== this.generation) return undefined;
    return ctx.workerId;
  }

  /**
   * Called by instrumented clients before doing any work. Outside a worker (test setup) it
   * passes immediately. Inside a worker it parks the worker until the schedule lets it through.
   */
  gate(label: string, args: readonly unknown[]): Promise<void> {
    if (!this.gates.has(label)) throw new Error(`gate ${JSON.stringify(label)} was never defined`);
    const ctx = currentWorkerContext();
    if (!ctx || ctx.owner !== this) return Promise.resolve();
    const w = ctx.generation === this.generation ? this.workers.get(ctx.workerId) : undefined;
    if (w?.status !== "running") {
      const why = w ? `while it was ${this.describe(w)}` : "after its run was reset";
      this.stray(`${ctx.workerId} called ${JSON.stringify(label)} ${why}`);
      return new Promise<void>(() => {}); // a stray call is never let through
    }
    return new Promise<void>((wake) => this.park(w, label, args, wake));
  }

  /** Records a call to an effect gate (after it was passed). */
  recordEffect(label: string, args: readonly unknown[]): void {
    const worker = this.currentWorkerId() ?? null;
    this.effectLog.push({ seq: this.seq++, worker, effect: label, args });
  }

  /** The scheduler-aware lock named `name` for the current run. */
  lock(name: string): SchedLock {
    let l = this.locks.get(name);
    if (!l) {
      l = new SchedLock(name, this);
      this.locks.set(name, l);
    }
    return l;
  }

  // ------------------------------------------------------------------ worker lifecycle

  /** spawned → running: run the worker's function in its own async context. */
  private start(w: Worker): void {
    if (w.status !== "spawned") throw internal(w, "start");
    w.status = "running";
    const generation = this.generation;
    runInWorker({ owner: this, generation, workerId: w.id }, async () => w.fn()).then(
      (value) => {
        if (generation === this.generation) this.complete(w, value);
      },
      (error: unknown) => {
        if (generation === this.generation) this.fail(w, error);
      },
    );
  }

  /** running → parked: an instrumented call stops before doing anything. */
  private park(w: Worker, gate: string, args: readonly unknown[], wake: () => void): void {
    if (w.status !== "running") throw internal(w, "park");
    w.status = "parked";
    w.gate = gate;
    w.args = args;
    w.wake = wake;
    this.notify();
  }

  /** parked → running: the parked call executes now (the worker "passes" the gate). */
  private pass(w: Worker): void {
    if (w.status !== "parked") throw internal(w, "pass");
    const { gate, args, wake } = w;
    w.status = "running";
    w.gate = undefined;
    w.args = [];
    w.wake = undefined;
    if (gate !== undefined) {
      w.passed.push(gate);
      this.log.push({ seq: this.seq++, worker: w.id, gate, args });
    }
    wake?.();
  }

  /** running → waiting: the worker requested a lock that another worker holds. */
  markWaiting(workerId: string, resource: string): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    if (w.status !== "running") throw internal(w, "wait");
    w.status = "waiting";
    w.resource = resource;
    this.notify();
  }

  /** waiting → ready: the lock was handed over, but the worker does not run until resumed. */
  markReady(workerId: string, resource: string, grant: () => void): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    if (w.status !== "waiting") throw internal(w, "grant");
    w.status = "ready";
    w.resource = resource;
    w.wake = grant;
    this.notify();
  }

  /** ready → running: a granted worker continues past its lock. */
  private wake(w: Worker): void {
    if (w.status !== "ready") throw internal(w, "wake");
    const grant = w.wake;
    w.status = "running";
    w.resource = undefined;
    w.wake = undefined;
    grant?.();
  }

  /** running → done: the worker's function returned. */
  private complete(w: Worker, value: unknown): void {
    if (w.status !== "running") {
      this.stray(`${w.id} returned while it was ${this.describe(w)}`);
      return;
    }
    w.status = "done";
    w.value = value;
    this.notify();
  }

  /** running → failed: the worker's function threw. */
  private fail(w: Worker, error: unknown): void {
    if (w.status !== "running") {
      this.stray(`${w.id} threw while it was ${this.describe(w)}`);
      return;
    }
    w.status = "failed";
    w.error = error;
    this.notify();
  }

  // ------------------------------------------------------------------ stepping

  private resume(w: Worker): void {
    if (w.status === "spawned") this.start(w);
    else if (w.status === "parked") this.pass(w);
    else if (w.status === "ready") this.wake(w);
    else throw internal(w, "resume");
  }

  private stray(message: string): void {
    this.strays.push(message);
    this.notify();
  }

  private notify(): void {
    this.changed.resolve();
    this.changed = signal();
  }

  /** Wait until `w` stops running: parked at a gate, waiting on a lock, or settled. */
  private async settle(ctx: StepContext, w: Worker, expected: string): Promise<void> {
    let timedOut = false;
    const timer = realSetTimeout(() => {
      timedOut = true;
      this.notify();
    }, this.stepTimeoutMs);
    try {
      while (w.status === "running" && this.strays.length === 0 && !timedOut) {
        await this.changed.promise;
      }
      // One macrotask turn after the worker stopped: anything else it started (a branch of
      // Promise.race / Promise.all, a fire-and-forget call) runs now and is caught as a stray,
      // instead of slipping into a later step.
      if (w.status !== "running") await new Promise<void>((r) => realSetImmediate(r));
    } finally {
      realClearTimeout(timer);
    }
    if (this.strays.length > 0) {
      const strays = this.strays.join("; ");
      throw this.diverge(ctx, "stray-gate", w, expected, strays, [
        `${strays}.`,
        "Only one call per worker may be in flight: concurrent gated calls inside one worker",
        "(Promise.all, fire-and-forget promises, callbacks that outlive the step) cannot be",
        "ordered by the schedule.",
      ]);
    }
    if (w.status === "running") {
      const last = w.passed.at(-1);
      const fakeTimers = globalThis.setTimeout !== realSetTimeout;
      throw this.diverge(ctx, "timeout", w, expected, "still running", [
        `${w.id} neither reached a gate nor settled within ${this.stepTimeoutMs} ms`,
        last ? `after passing ${JSON.stringify(last)}.` : "after it started.",
        "It is probably awaiting something the scheduler does not control: a real timer or",
        "I/O, an uninstrumented lock, or a fake timer that is never advanced.",
        fakeTimers ? "Fake timers are installed (vi.useFakeTimers); replays need real timers." : "",
      ]);
    }
  }

  private async runStep(ctx: StepContext): Promise<void> {
    const [id, target] = ctx.step;
    const w = this.workers.get(id) as Worker; // validated
    for (;;) {
      switch (w.status) {
        case "spawned":
        case "ready":
          this.resume(w);
          await this.settle(ctx, w, target);
          break;
        case "parked": {
          const gate = w.gate as string;
          if (target === UNTIL_DONE || gate === target) {
            this.resume(w);
            await this.settle(ctx, w, target);
            if (target !== UNTIL_DONE) return;
          } else if (this.gates.kind(gate) === "transparent") {
            this.resume(w);
            await this.settle(ctx, w, target);
          } else {
            throw this.diverge(ctx, "different-gate", w, target, gate, [
              `${id} reached sync gate ${JSON.stringify(gate)} but the schedule expects`,
              `${JSON.stringify(target)} next.`,
            ]);
          }
          break;
        }
        case "waiting":
          throw this.blocked(ctx, w, target);
        case "done":
          if (target === UNTIL_DONE) return;
          throw this.diverge(ctx, "finished-early", w, target, "returned", [
            `${id} returned ${preview(w.value)} without reaching ${JSON.stringify(target)}.`,
          ]);
        case "failed":
          if (target === UNTIL_DONE) return;
          throw this.diverge(
            ctx,
            "threw",
            w,
            target,
            errorMessage(w.error),
            [`${id} threw before reaching ${JSON.stringify(target)}: ${errorMessage(w.error)}`],
            w.error,
          );
        case "running":
          throw internal(w, "step");
      }
    }
  }

  private blocked(ctx: StepContext, w: Worker, target: string): ReplayDivergence {
    const resource = this.resourceOf(w);
    const chain: string[] = [w.id];
    let cur: Worker | undefined = w;
    while (cur?.status === "waiting" && cur.resource !== undefined) {
      const holder = this.locks.get(cur.resource)?.holderId();
      if (holder === undefined) break;
      if (chain.includes(holder)) {
        chain.push(holder);
        return this.diverge(ctx, "deadlock", w, target, resource, [
          `wait-for cycle: ${chain.join(" → ")}.`,
        ]);
      }
      chain.push(holder);
      cur = this.workers.get(holder);
    }
    const holder = chain[1] ?? "nobody";
    const holderWorker = this.workers.get(holder);
    return this.diverge(ctx, "blocked", w, target, resource, [
      `${w.id} is waiting for ${resource} held by ${holder}`,
      holderWorker ? `(${this.describe(holderWorker)})` : "",
      `and cannot reach ${JSON.stringify(target)} until ${holder} releases it.`,
      "The code serialises these workers more strictly than the schedule assumes.",
    ]);
  }

  private resourceOf(w: Worker): string {
    return w.resource === undefined ? "(nothing)" : JSON.stringify(w.resource);
  }

  private validate(schedule: Schedule): void {
    for (const [index, step] of schedule.entries()) {
      const ctx = { index, step, stepCount: schedule.length };
      const [id, target] = step;
      const w = this.workers.get(id);
      if (!w) {
        const known = [...this.workers.keys()].join(", ") || "none";
        throw this.diverge(ctx, "invalid-schedule", undefined, target, "unknown worker", [
          `no worker ${JSON.stringify(id)} was spawned (spawned: ${known}).`,
        ]);
      }
      if (target !== UNTIL_DONE && !this.gates.has(target)) {
        throw this.diverge(ctx, "invalid-schedule", w, target, "unknown gate", [
          `no instrumented client defines gate ${JSON.stringify(target)}.`,
          `Known gates: ${this.gates.labels().join(", ")}.`,
        ]);
      }
    }
  }

  private describe(w: Worker): string {
    switch (w.status) {
      case "spawned":
        return "not started";
      case "running":
        return "running";
      case "parked":
        return `parked at ${JSON.stringify(w.gate)}`;
      case "waiting": {
        const holder = w.resource && this.locks.get(w.resource)?.holderId();
        return `waiting for ${JSON.stringify(w.resource)} (held by ${holder ?? "nobody"})`;
      }
      case "ready":
        return `ready (acquired ${JSON.stringify(w.resource)}, not yet resumed)`;
      case "done":
        return `done → ${preview(w.value)}`;
      case "failed":
        return `threw ${errorMessage(w.error)}`;
    }
  }

  private diverge(
    ctx: StepContext,
    kind: DivergenceKind,
    w: Worker | undefined,
    expected: string,
    actual: string,
    explanation: string[],
    cause?: unknown,
  ): ReplayDivergence {
    const details: DivergenceDetails = {
      kind,
      stepIndex: ctx.index,
      step: ctx.step,
      stepCount: ctx.stepCount,
      worker: w?.id ?? ctx.step[0],
      expected,
      actual,
      explanation: explanation.filter(Boolean).join(" "),
      workers: this.snapshot(),
      completed: [...this.completed],
    };
    if (cause !== undefined) details.cause = cause;
    return new ReplayDivergence(details);
  }
}

/** A one-shot "something changed" signal. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function internal(w: Worker, action: string): Error {
  return new Error(
    `@tsverify/runtime internal error: cannot ${action} worker ${w.id} (${w.status})`,
  );
}

export function scheduler(options?: SchedulerOptions): Scheduler {
  return new Scheduler(options);
}
