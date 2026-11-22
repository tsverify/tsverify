export type JobStatus = "queued" | "running" | "done" | "failed";

/** The entity is the object itself: its methods write `this.status`. */
export class Job {
  status: JobStatus;

  constructor(readonly id: string) {
    this.status = "queued"; // initialization, not a transition
  }

  start(): void {
    if (this.status !== "queued") throw new Error(`job ${this.id} is ${this.status}`);
    this.status = "running";
  }

  async finish(work: Promise<void>): Promise<void> {
    if (this.status !== "running") return;
    await work;
    this.status = "done";
  }
}
