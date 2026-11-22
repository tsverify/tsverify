/**
 * Worker identity. Every worker function runs inside `runInWorker`, and `AsyncLocalStorage`
 * carries the context through every `await`, promise continuation and timer the worker creates,
 * so an instrumented call always knows which worker made it.
 *
 * There must be exactly one copy of this module in a test process: the test file and the
 * `vi.mock` factories have to load the same `@tsverify/runtime`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkerContext {
  /** The scheduler that spawned the worker (compared by identity). */
  readonly owner: object;
  /** The scheduler run (`reset()` count) the worker belongs to. */
  readonly generation: number;
  readonly workerId: string;
}

const storage = new AsyncLocalStorage<WorkerContext>();

/** Runs `fn` as the given worker. Everything `fn` schedules inherits the context. */
export function runInWorker<T>(context: WorkerContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The context of the worker whose code is running, or `undefined` outside any worker. */
export function currentWorkerContext(): WorkerContext | undefined {
  return storage.getStore();
}
