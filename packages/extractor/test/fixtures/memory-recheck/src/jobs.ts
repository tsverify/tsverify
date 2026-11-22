export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
}

declare function log(line: string): Promise<void>;

/** The `await` comes before the re-check: nothing suspends between the check and the write. */
export async function startRechecked(job: Job): Promise<void> {
  await log("start");
  if (job.status !== "queued") return;
  job.status = "running";
}

/** The `await` lies between the check and the write: another caller can interleave. */
export async function startStale(job: Job): Promise<void> {
  if (job.status !== "queued") return;
  await log("start");
  job.status = "running";
}

/** Re-checked on one path only: the other path still suspends after its last check. */
export async function finishMaybe(job: Job, careful: boolean): Promise<void> {
  if (job.status !== "running") return;
  await log("finish");
  if (careful && job.status !== "running") return;
  job.status = "done";
}

/** Checking another job's status after the `await` does not re-check this one. */
export async function failOther(job: Job, other: Job): Promise<void> {
  if (job.status !== "running") return;
  await log("fail");
  if (other.status !== "running") return;
  job.status = "failed";
}

/** Re-checked in the impl after the `await`, written in a helper: atomic. */
export async function startViaHelper(job: Job): Promise<void> {
  await log("start");
  if (job.status !== "queued") return;
  markRunning(job);
}

function markRunning(job: Job): void {
  job.status = "running";
}

/** The caller awaits, the helper re-checks before writing: atomic. */
export async function finishInHelper(job: Job): Promise<void> {
  await log("finish");
  setDone(job);
}

function setDone(job: Job): void {
  if (job.status !== "running") return;
  job.status = "done";
}

/** Re-checked inside the deferred callback, which is where the suspension is: atomic. */
export function failLater(job: Job, crash: Promise<void>): void {
  crash.then(() => {
    if (job.status !== "running") return;
    job.status = "failed";
  });
}
