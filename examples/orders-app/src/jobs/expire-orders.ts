import { db } from "../db";

/**
 * Cancels an order that is still unpaid. The job queue schedules it 30 minutes after checkout;
 * if the payment arrived in the meantime it does nothing.
 *
 * @returns whether the order was cancelled
 */
export async function expireOrder(orderId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "pending_payment") return false;
    order.status = "cancelled";
    await tx.orders.save(order);
    return true;
  });
}
