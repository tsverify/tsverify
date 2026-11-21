import { AsyncLocalStorage } from "node:async_hooks";
import {
  type DivergenceDetails,
  type DivergenceKind,
  ReplayDivergence,
  type WorkerSnapshot,
} from "./divergence";

/** Step target meaning "run this worker until its function settles (returns or throws)". */
export const UNTIL_DONE = "until-done";

/** `[workerId, gateLabel | "until-done"]`. See README "Scheduler semantics". */
export type Step = readonly [worker: string, target: string];
export type Schedule = readonly Step[];

/**
 * - `sync`: a model-level synchronisation point (entity read or write). A step can only pass
 *   the sync gate it names; reaching a different one is a divergence.
 * - `transparent`: an intermediate gate (transaction begin, external effect). A step heading for
 *   another gate passes it automatically; a step can also name it explicitly to stop there.
 *   Transparent gates still serialise workers and are recorded in the log.
 */
export type GateKind = "sync" | "transparent";

export type WorkerState =
  | { kind: "new" }
  | { kind: "running" }
  | { kind: "parked"; gate: string; args: readonly unknown[] }
  | { kind: "waiting"; resource: string }
  | { kind: "ready"; resource: string }
  | { kind: "done"; value: unknown }
  | { kind: "failed"; error: unknown };

export interface GateEvent {
  seq: number;
  worker: string;
  gate: string;
  args: readonly unknown[];
}

export interface EffectCall {
  seq: number;
  /** Worker id, or `null` when called outside any worker (test setup). */
  worker: string | null;
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

interface Worker {
  id: string;
  fn: () => unknown;
  state: WorkerState;
  /** Set while the worker is suspended under scheduler control (new, parked, ready). */
  resume: (() => void) | undefined;
  passed: string[];
}

interface Context {
  scheduler: Scheduler;
  generation: number;
  worker: Worker;
}

interface StepContext {
  index: number;
  step: Step;
  stepCount: number;
}

const als = new AsyncLocalStorage<Context>();
const EXTERNAL = "(outside any worker)";

/** A mutex that reports "waiting" and "ready" to the scheduler instead of resuming on its own. */
export class SchedLock {
  private holder: Worker | typeof EXTERNAL | undefined;
  private readonly queue: { worker: Worker | undefined; grant: () => void }[] = [];

  constructor(
    readonly name: string,
    private readonly s: Scheduler,
  ) {}

  holderId(): string | undefined {
    if (this.holder === undefined) return undefined;
    return this.holder === EXTERNAL ? EXTERNAL : this.holder.id;
  }

  acquire(): Promise<void> {
    const w = this.s.currentWorker();
    if (this.holder === undefined) {
      this.holder = w ?? EXTERNAL;
      return Promise.resolve();
    }
    return new Promise<void>((grant) => {
      this.queue.push({ worker: w, grant });
      if (w) this.s.markWaiting(w, this.name);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.holder = undefined;
      return;
    }
    this.holder = next.worker ?? EXTERNAL;
    // A worker that gets the lock does NOT resume by itself: it becomes `ready` and waits for the
    // schedule (or drain) to pick it. Only one worker ever runs at a time.
    if (next.worker) this.s.markReady(next.worker, this.name, next.grant);
    else next.grant();
  }
}

export class Scheduler {
  private readonly stepTimeoutMs: number;
  private readonly gates = new Map<string, GateKind>();
  private readonly resetHooks: (() => void)[] = [];
  private generation = 0;
  private workers = new Map<string, Worker>();
  private locks = new Map<string, SchedLock>();
  private log: GateEvent[] = [];
  private effectLog: EffectCall[] = [];
  private strays: string[] = [];
  private completed: Step[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();

  constructor(options: SchedulerOptions = {}) {
    this.stepTimeoutMs = options.stepTimeoutMs ?? 2000;
  }

  // ---------------------------------------------------------------- public API (tests)

  /** Register a worker. It does not start until a step (or `drain`) schedules it. */
  spawn(id: string, fn: () => unknown): void {
    if (this.workers.has(id)) throw new Error(`worker ${JSON.stringify(id)} already spawned`);
    const w: Worker = { id, fn, state: { kind: "new" }, resume: undefined, passed: [] };
    w.resume = () => this.start(w);
    this.workers.set(id, w);
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
      const next = [...this.workers.values()].find((w) => w.resume !== undefined);
      if (!next) {
        const waiting = [...this.workers.values()].filter((w) => w.state.kind === "waiting");
        if (waiting.length === 0) return;
        const first = waiting[0] as Worker;
        throw this.diverge(ctx, "deadlock", first, UNTIL_DONE, describe(first.state), [
          `every unfinished worker is waiting: ${waiting.map((w) => `${w.id} on ${this.resourceOf(w)}`).join(", ")}.`,
        ]);
      }
      this.resumeWorker(next);
      await this.settle(ctx, next, UNTIL_DONE);
    }
  }

  /** Discard all workers, logs, locks and fake data (stores reset to empty). */
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
    if (w.state.kind === "done") return { status: "done", value: w.state.value };
    if (w.state.kind === "failed") return { status: "failed", error: w.state.error };
    return { status: "unfinished", state: describe(w.state) };
  }

  /** Every gate passed so far, in order. */
  gateLog(): GateEvent[] {
    return [...this.log];
  }

  /** Recorded effect calls, optionally filtered by label (e.g. `stripe.refunds.create`). */
  effects(label?: string): EffectCall[] {
    return this.effectLog.filter((e) => label === undefined || e.effect === label);
  }

  snapshot(): WorkerSnapshot[] {
    return [...this.workers.values()].map((w) => ({
      id: w.id,
      state: this.describeWorker(w),
      passed: [...w.passed],
    }));
  }

  // ---------------------------------------------------------------- instrument API

  defineGate(label: string, kind: GateKind): void {
    const prev = this.gates.get(label);
    if (prev && prev !== kind) throw new Error(`gate ${label} already defined as ${prev}`);
    this.gates.set(label, kind);
  }

  onReset(hook: () => void): void {
    this.resetHooks.push(hook);
  }

  /** The worker whose async context we are in, if it belongs to this scheduler's current run. */
  currentWorker(): Worker | undefined {
    const ctx = als.getStore();
    if (!ctx || ctx.scheduler !== this || ctx.generation !== this.generation) return undefined;
    return ctx.worker;
  }

  /**
   * Called by instrumented clients before doing their work. Outside a worker (test setup) it
   * passes immediately. Inside a worker it parks the worker until the scheduler lets it through.
   */
  gate(label: string, args: readonly unknown[]): Promise<void> {
    if (!this.gates.has(label)) throw new Error(`gate ${label} was never defined`);
    const ctx = als.getStore();
    if (!ctx || ctx.scheduler !== this) return Promise.resolve();
    const w = ctx.worker;
    if (ctx.generation !== this.generation || w.state.kind !== "running") {
      const why =
        ctx.generation !== this.generation
          ? "after its run was reset"
          : `while it was ${describe(w.state)}`;
      this.strays.push(`${w.id} called ${JSON.stringify(label)} ${why}`);
      this.notify();
      return new Promise<void>(() => {}); // never let a stray call through
    }
    return new Promise<void>((pass) => {
      w.state = { kind: "parked", gate: label, args };
      w.resume = () => {
        w.state = { kind: "running" };
        w.passed.push(label);
        this.log.push({ seq: this.seq++, worker: w.id, gate: label, args });
        pass();
      };
      this.notify();
    });
  }

  recordEffect(label: string, args: readonly unknown[]): void {
    const w = this.currentWorker();
    this.effectLog.push({ seq: this.seq++, worker: w?.id ?? null, effect: label, args });
  }

  lock(name: string): SchedLock {
    let l = this.locks.get(name);
    if (!l) {
      l = new SchedLock(name, this);
      this.locks.set(name, l);
    }
    return l;
  }

  markWaiting(w: Worker, resource: string): void {
    w.state = { kind: "waiting", resource };
    this.notify();
  }

  markReady(w: Worker, resource: string, grant: () => void): void {
    w.state = { kind: "ready", resource };
    w.resume = () => {
      w.state = { kind: "running" };
      grant();
    };
    this.notify();
  }

  // ---------------------------------------------------------------- internals

  private start(w: Worker): void {
    w.state = { kind: "running" };
    const generation = this.generation;
    const ctx: Context = { scheduler: this, generation, worker: w };
    als
      .run(ctx, async () => w.fn())
      .then(
        (value) => this.finish(w, generation, { kind: "done", value }),
        (error: unknown) => this.finish(w, generation, { kind: "failed", error }),
      );
  }

  private finish(w: Worker, generation: number, state: WorkerState): void {
    if (generation !== this.generation) return;
    w.state = state;
    w.resume = undefined;
    this.notify();
  }

  private resumeWorker(w: Worker): void {
    const resume = w.resume;
    if (!resume) throw new Error(`internal: worker ${w.id} is not resumable`);
    w.resume = undefined;
    resume();
  }

  private notify(): void {
    const listeners = this.listeners;
    this.listeners = new Set();
    for (const l of listeners) l();
  }

  private waitForChange(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onChange = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(onChange);
        resolve(false);
      }, ms);
      this.listeners.add(onChange);
    });
  }

  /** Wait until `w` stops running: parked at a gate, waiting on a resource, or settled. */
  private async settle(ctx: StepContext, w: Worker, expected: string): Promise<void> {
    const deadline = Date.now() + this.stepTimeoutMs;
    while (w.state.kind === "running" && this.strays.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await this.waitForChange(remaining))) {
        const last = w.passed.at(-1);
        throw this.diverge(ctx, "timeout", w, expected, "still running", [
          `${w.id} neither reached a gate nor settled within ${this.stepTimeoutMs} ms`,
          last ? `after passing ${JSON.stringify(last)}.` : "after it started.",
          "It is probably awaiting something the scheduler does not control: a real timer or",
          "I/O, an uninstrumented lock, or a fake timer that is never advanced.",
        ]);
      }
    }
    if (this.strays.length > 0) {
      throw this.diverge(ctx, "stray-gate", w, expected, this.strays.join("; "), [
        `${this.strays.join("; ")}.`,
        "Only one call per worker may be in flight: concurrent gated calls inside one worker",
        "(Promise.all, fire-and-forget promises, callbacks that outlive the step) cannot be",
        "ordered by the schedule.",
      ]);
    }
  }

  private async runStep(ctx: StepContext): Promise<void> {
    const [id, target] = ctx.step;
    const w = this.workers.get(id) as Worker; // validated
    for (;;) {
      const st = w.state;
      switch (st.kind) {
        case "new":
        case "ready":
          this.resumeWorker(w);
          await this.settle(ctx, w, target);
          break;
        case "parked":
          if (target === UNTIL_DONE || st.gate === target) {
            this.resumeWorker(w);
            await this.settle(ctx, w, target);
            if (target !== UNTIL_DONE) return;
          } else if (this.gates.get(st.gate) === "transparent") {
            this.resumeWorker(w);
            await this.settle(ctx, w, target);
          } else {
            throw this.diverge(ctx, "different-gate", w, target, st.gate, [
              `${id} reached sync gate ${JSON.stringify(st.gate)} but the schedule expects`,
              `${JSON.stringify(target)} next.`,
            ]);
          }
          break;
        case "waiting":
          throw this.blocked(ctx, w, target);
        case "done":
          if (target === UNTIL_DONE) return;
          throw this.diverge(ctx, "finished-early", w, target, "returned", [
            `${id} returned ${preview(st.value)} without reaching ${JSON.stringify(target)}.`,
          ]);
        case "failed":
          if (target === UNTIL_DONE) return;
          throw this.diverge(
            ctx,
            "threw",
            w,
            target,
            errorMessage(st.error),
            [`${id} threw before reaching ${JSON.stringify(target)}: ${errorMessage(st.error)}`],
            st.error,
          );
        case "running":
          throw new Error(`internal: worker ${id} is running between steps`);
      }
    }
  }

  private blocked(ctx: StepContext, w: Worker, target: string): ReplayDivergence {
    const resource = this.resourceOf(w);
    const chain: string[] = [w.id];
    let cur: Worker | undefined = w;
    while (cur && cur.state.kind === "waiting") {
      const holder = this.locks.get(cur.state.resource)?.holderId();
      if (!holder) break;
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
    const holderState = this.workers.get(holder);
    return this.diverge(ctx, "blocked", w, target, resource, [
      `${w.id} is waiting for ${resource} held by ${holder}`,
      holderState ? `(${describe(holderState.state)})` : "",
      `and cannot reach ${JSON.stringify(target)} until ${holder} releases it.`,
      "The code serialises these workers more strictly than the schedule assumes.",
    ]);
  }

  private resourceOf(w: Worker): string {
    return w.state.kind === "waiting" ? JSON.stringify(w.state.resource) : "(nothing)";
  }

  private validate(schedule: Schedule): void {
    for (const [index, step] of schedule.entries()) {
      const ctx = { index, step, stepCount: schedule.length };
      const [id, target] = step;
      const w = this.workers.get(id);
      if (!w) {
        const known = [...this.workers.keys()].join(", ") || "none";
        throw this.diverge(ctx, "invalid-schedule", undefined, target, `unknown worker`, [
          `no worker ${JSON.stringify(id)} was spawned (spawned: ${known}).`,
        ]);
      }
      if (target !== UNTIL_DONE && !this.gates.has(target)) {
        throw this.diverge(ctx, "invalid-schedule", w, target, "unknown gate", [
          `no instrumented client defines gate ${JSON.stringify(target)}.`,
          `Known gates: ${[...this.gates.keys()].join(", ")}.`,
        ]);
      }
    }
  }

  private describeWorker(w: Worker): string {
    if (w.state.kind === "waiting") {
      const holder = this.locks.get(w.state.resource)?.holderId() ?? "nobody";
      return `waiting for ${JSON.stringify(w.state.resource)} (held by ${holder})`;
    }
    return describe(w.state);
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
      cause,
    };
    return new ReplayDivergence(details);
  }
}

function describe(st: WorkerState): string {
  switch (st.kind) {
    case "new":
      return "not started";
    case "running":
      return "running";
    case "parked":
      return `parked at ${JSON.stringify(st.gate)}`;
    case "waiting":
      return `waiting for ${JSON.stringify(st.resource)}`;
    case "ready":
      return `ready (acquired ${JSON.stringify(st.resource)}, not yet resumed)`;
    case "done":
      return `done → ${preview(st.value)}`;
    case "failed":
      return `threw ${errorMessage(st.error)}`;
  }
}

function preview(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export function scheduler(options?: SchedulerOptions): Scheduler {
  return new Scheduler(options);
}
