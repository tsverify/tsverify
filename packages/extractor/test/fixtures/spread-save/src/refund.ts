import { db } from "../../_lib/db";
import type { OrderStatus } from "../../_lib/order";

/** The write is a spread passed straight to the commit (spike X1 case 11). */
export async function refundOrder(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    await tx.orders.save({ ...order, status: "refunded" });
  });
}

/** A non-literal target state is not extracted (unanalyzable warning). */
export async function setStatus(orderId: string, next: OrderStatus): Promise<void> {
  const order = await db.orders.get(orderId);
  await db.orders.save({ ...order, status: next });
}
