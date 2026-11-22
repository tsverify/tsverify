export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  result?: string;
}

/** Check and write with nothing in between: atomic. */
export function startJob(job: Job): void {
  if (job.status !== "queued") throw new Error(`job ${job.id} is ${job.status}`);
  job.status = "running";
}

/** An async impl whose only `await` comes after the write: still atomic. */
export async function finishJob(job: Job, result: Promise<string>): Promise<void> {
  if (job.status !== "running") return;
  job.status = "done";
  job.result = await result;
}

/**
 * An async helper called (not awaited) before the write runs synchronously up to its own first
 * `await`, and an `await` inside an inline callback suspends only that callback: atomic.
 */
export function failJob(job: Job, pending: readonly Promise<unknown>[]): void {
  if (job.status !== "running") return;
  void audit(job.id);
  pending.forEach(async (p) => {
    await p;
  });
  job.status = "failed";
}

async function audit(id: string): Promise<void> {
  await Promise.resolve(id);
}
