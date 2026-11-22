// Seeded bug B3: non-atomic check-then-act. Two concurrent refunds can both observe `paid`.

import { auditNote } from "./audit";
import { db } from "./db";
import { stripe } from "./stripe";

export type RefundResult =
  | { refunded: true; refundId: string }
  | { refunded: false; reason: string };

export async function refundOrder(id: string): Promise<RefundResult> {
  const order = await db.orders.get(id);
  if (!order) throw new Error(`order ${id} not found`);
  await Promise.resolve(); // unrelated microtask noise
  if (order.status !== "paid") return { refunded: false, reason: `order is ${order.status}` };

  const note = await auditNote(order, "refund");
  const refund = await stripe.refunds.create({ charge: order.chargeId, metadata: { note } });

  order.status = "refunded";
  await db.orders.save(order);
  return { refunded: true, refundId: refund.id };
}
