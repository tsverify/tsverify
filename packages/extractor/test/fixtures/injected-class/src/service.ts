import { db } from "../../_lib/db";
import type { Notifier, Queue } from "./queue";

interface Resources {
  queue: Queue;
  notifier: Notifier;
}

/** The queue arrives as an injected instance, `this.$.queue`, typed as the class. */
export class Service {
  constructor(private readonly $: Resources) {}

  async ship(orderId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const order = await tx.orders.get(orderId);
      if (order.status !== "paid") throw new Error("not paid");
      order.status = "shipped";
      await tx.orders.save(order);
    });
    await this.$.queue.ack(orderId);
    await this.$.notifier.notify(orderId);
  }
}
