/** What a `SchedLock` needs from its scheduler. */
export interface LockHost {
  /** The id of the worker whose code is running, or `undefined` outside any worker. */
  currentWorkerId(): string | undefined;
  /** The running worker found the lock held: it stops running until it is granted the lock. */
  markWaiting(workerId: string, resource: string): void;
  /** A waiting worker was granted the lock: `grant` lets it continue once it is resumed. */
  markReady(workerId: string, resource: string, grant: () => void): void;
}

/** Holder id used for calls made outside any worker (test setup). */
export const OUTSIDE_WORKER = "(outside any worker)";

/**
 * A FIFO mutex that reports "waiting" and "ready" to the scheduler instead of resuming waiters on
 * its own: a worker granted the lock does not run until the schedule (or `drain`) resumes it, so a
 * lock never runs a second worker behind the schedule's back.
 */
export class SchedLock {
  private holder: string | undefined;
  private readonly queue: { worker: string | undefined; grant: () => void }[] = [];

  constructor(
    readonly name: string,
    private readonly host: LockHost,
  ) {}

  /** The holder's worker id, `OUTSIDE_WORKER`, or `undefined` when the lock is free. */
  holderId(): string | undefined {
    return this.holder;
  }

  acquire(): Promise<void> {
    const worker = this.host.currentWorkerId();
    if (this.holder === undefined) {
      this.holder = worker ?? OUTSIDE_WORKER;
      return Promise.resolve();
    }
    return new Promise<void>((grant) => {
      this.queue.push({ worker, grant });
      if (worker !== undefined) this.host.markWaiting(worker, this.name);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.holder = undefined;
      return;
    }
    this.holder = next.worker ?? OUTSIDE_WORKER;
    if (next.worker !== undefined) this.host.markReady(next.worker, this.name, next.grant);
    else next.grant();
  }
}
