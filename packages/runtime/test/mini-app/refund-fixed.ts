// Fixed refund: the state check and the write happen atomically inside a transaction. Stripe is
// called only after this worker won the `paid -> refunded` transition.

import { auditNote } from "./audit";
import { db } from "./db";
import type { RefundResult } from "./refund-buggy";
import { stripe } from "./stripe";

export async function refundOrder(id: string): Promise<RefundResult> {
  const won = await db.transaction(async (tx) => {
    const order = await tx.orders.get(id);
    if (!order) throw new Error(`order ${id} not found`);
    await Promise.resolve(); // unrelated microtask noise
    if (order.status !== "paid") return { ok: false as const, status: order.status };
    order.status = "refunded";
    await tx.orders.save(order);
    return { ok: true as const, order };
  });
  if (!won.ok) return { refunded: false, reason: `order is ${won.status}` };

  const note = await auditNote(won.order, "refund");
  const refund = await stripe.refunds.create({ charge: won.order.chargeId, metadata: { note } });
  return { refunded: true, refundId: refund.id };
}
