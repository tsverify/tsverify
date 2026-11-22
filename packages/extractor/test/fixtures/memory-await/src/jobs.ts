export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  result?: string;
}

/** An `await` between the check and the write: another caller can start the job meanwhile. */
export async function startJob(job: Job, ready: Promise<void>): Promise<void> {
  if (job.status !== "queued") throw new Error(`job ${job.id} is ${job.status}`);
  await ready;
  job.status = "running";
}

/** The written value is awaited: the suspension still precedes the assignment. */
export async function finishJob(job: Job, result: Promise<"done">): Promise<void> {
  if (job.status !== "running") return;
  job.status = await result;
}

/** Every `for await` step suspends, including the one that ends the loop. */
export async function drainJob(job: Job, chunks: AsyncIterable<string>): Promise<void> {
  if (job.status !== "running") return;
  for await (const chunk of chunks) job.result = chunk;
  job.status = "done";
}

/** A generator suspends at `yield`. */
export function* stepJob(job: Job): Generator<void, void, void> {
  if (job.status !== "queued") return;
  yield;
  job.status = "running";
}

/** A `.then` callback runs in a later microtask, after the impl returned. */
export function failLater(job: Job, crash: Promise<void>): void {
  if (job.status !== "running") return;
  crash.then(() => {
    job.status = "failed";
  });
}
