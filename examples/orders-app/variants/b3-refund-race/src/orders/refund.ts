import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { db } from "../db";
import { InvalidTransitionError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";

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
