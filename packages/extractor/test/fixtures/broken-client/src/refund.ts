import { stripe } from "../../_lib/clients";
import { db } from "../../_lib/db";
import { requireRole } from "../../_lib/guards";
import type { Actor } from "../../_lib/order";

export async function refundOrder(ctx: { actor: Actor }, orderId: string): Promise<void> {
  requireRole(ctx.actor, "admin");
  const charge = await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid" || order.chargeId === undefined) throw new Error("not refundable");
    order.status = "refunded";
    await tx.orders.save(order);
    return order.chargeId;
  });
  await stripe.refunds.create({ charge });
}
