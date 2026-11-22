import { db } from "../../_lib/db";
import type { Actor } from "../../_lib/order";

/** Read, check, write and save all through `tx`: atomic. */
export async function shipOrder(ctx: { actor: Actor }, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
  void ctx;
}

/** Inside a transaction callback, but reads and saves through the root `db`: not atomic. */
export async function shipBypassingTx(orderId: string): Promise<void> {
  await db.transaction(async () => {
    const order = await db.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await db.orders.save(order);
  });
}
