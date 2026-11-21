import { db } from "../db";
import { stripe } from "../payments/stripe";

/**
 * Cancels an order that is still unpaid. The job queue schedules it 30 minutes after checkout;
 * if the payment arrived in the meantime it does nothing.
 *
 * @returns whether the order was cancelled
 */
export async function expireOrder(orderId: string): Promise<boolean> {
  const expired = await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "pending_payment") return undefined;
    order.status = "cancelled";
    await tx.orders.save(order);
    return order;
  });
  if (expired === undefined) return false;
  // Hand back any charge Stripe captured while the order sat unpaid.
  if (expired.chargeId !== undefined) {
    await stripe.refunds.create({ charge: expired.chargeId });
  }
  return true;
}
