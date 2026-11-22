import { db } from "../../_lib/db";

export async function shipOrder(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export const notAFunction = 42;
