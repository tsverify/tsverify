import { stripe } from "../../_lib/clients";
import { db } from "../../_lib/db";

/** Check-then-act without a transaction (the B3 shape). */
export async function refundOrder(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (order.status !== "paid" || order.chargeId === undefined) throw new Error("not refundable");
  await stripe.refunds.create({ charge: order.chargeId });
  order.status = "refunded";
  await db.orders.save(order);
}
