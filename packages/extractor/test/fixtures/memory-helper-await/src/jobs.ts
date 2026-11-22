export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
}

/** The impl has no `await` before the helper call, but the helper awaits before writing. */
export async function startJob(job: Job, ready: Promise<void>): Promise<void> {
  await markRunning(job, ready);
}

async function markRunning(job: Job, ready: Promise<void>): Promise<void> {
  if (job.status !== "queued") return;
  await ready;
  job.status = "running";
}

/**
 * Two levels down: impl → finish → setDone, with the `await` in the middle frame, after the
 * check and before the helper that writes.
 */
export function finishJob(job: Job, flushed: Promise<void>): Promise<void> {
  return finish(job, flushed);
}

async function finish(job: Job, flushed: Promise<void>): Promise<void> {
  if (job.status !== "running") return;
  await flushed;
  setDone(job);
}

function setDone(job: Job): void {
  job.status = "done";
}

/** A helper that awaits only after its write: atomic. */
export async function failJob(job: Job, logged: Promise<void>): Promise<void> {
  await markFailed(job, logged);
}

async function markFailed(job: Job, logged: Promise<void>): Promise<void> {
  if (job.status !== "running") return;
  job.status = "failed";
  await logged;
}
