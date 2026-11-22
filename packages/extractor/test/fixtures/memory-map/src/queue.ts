export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
}

export interface FinishEvent {
  jobId: string;
}

/** Jobs looked up by id: the id argument is the invocation's entity id. */
export class Queue {
  private jobs = new Map<string, Job>();
  private byId: Record<string, Job> = {};

  start(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return;
    job.status = "running";
  }

  finish(event: FinishEvent): void {
    const job = this.jobs.get(event.jobId);
    if (job?.status !== "running") return;
    job.status = "done";
  }

  fail(id: string): void {
    const job = this.byId[id];
    if (job?.status !== "running") return;
    job.status = "failed";
  }

  /** A literal key carries no argument: no invocation shape. */
  startFirst(): void {
    const job = this.jobs.get("first");
    if (job?.status !== "queued") return;
    job.status = "running";
  }
}
