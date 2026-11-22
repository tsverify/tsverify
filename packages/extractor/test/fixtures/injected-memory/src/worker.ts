import type { EventBus } from "./bus";

export type JobStatus = "queued" | "running" | "done" | "failed";

/** Same shape as `EventBus`, but a different type: not the bound client. */
export interface Tracer {
  publish(topic: string): void;
}

/** An in-process entity with its event bus injected. */
export class Worker {
  status: JobStatus = "queued";

  constructor(
    private readonly bus: EventBus,
    private readonly tracer: Tracer,
  ) {}

  start(): void {
    if (this.status !== "queued") throw new Error("not queued");
    this.status = "running";
    this.bus.publish("job.started");
    this.tracer.publish("start");
  }
}
