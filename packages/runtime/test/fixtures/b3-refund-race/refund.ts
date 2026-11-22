import type { Actor } from "../../../../../examples/orders-app/src/auth/actor";
import { requireRole } from "../../../../../examples/orders-app/src/auth/guards";
import { db } from "../../../../../examples/orders-app/src/db";
import { InvalidTransitionError } from "../../../../../examples/orders-app/src/errors";
import { type Refund, stripe } from "../../../../../examples/orders-app/src/payments/stripe";

/** An admin refunds a paid order: refund the charge first, then record the refund. */
export async function refundOrder(ctx: { actor: Actor }, orderId: string): Promise<Refund> {
  requireRole(ctx.actor, "admin");
  const order = await db.orders.get(orderId);
  if (order.status !== "paid") throw new InvalidTransitionError("refund", order.status);
  if (order.chargeId === undefined) throw new Error(`paid order ${order.id} has no charge`);
  const refund = await stripe.refunds.create({ charge: order.chargeId });
  order.status = "refunded";
  await db.orders.save(order);
  return refund;
}
