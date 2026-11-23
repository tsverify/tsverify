/** A client the app constructs itself and hands around: bound by its class. */
export class Queue {
  async ack(_orderId: string): Promise<void> {}
  async nack(_orderId: string): Promise<void> {}
  /** Only reads. */
  async isPaused(): Promise<boolean> {
    return false;
  }
}

/** A client the app knows only by an interface: bound by the interface. */
export interface Notifier {
  notify(orderId: string): Promise<void>;
}

/** Bound, but nothing ever calls it. */
export const audit = {
  log(_what: string): void {},
};
