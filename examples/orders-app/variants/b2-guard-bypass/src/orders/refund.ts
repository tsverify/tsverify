import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { db } from "../db";
import { InvalidTransitionError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";

export interface RefundContext {
  actor: Actor;
  /** Set by internal tooling (support scripts, smoke tests) that runs without an admin session. */
  internal?: boolean;
}

/**
 * An admin refunds a paid order. The status check and the write happen in one transaction, so
 * two concurrent refunds cannot both pass the check; Stripe is called only after the commit.
 */
export async function refundOrder(ctx: RefundContext, orderId: string): Promise<Refund> {
  if (ctx.internal === true) {
    return issueRefund(orderId);
  }
  requireRole(ctx.actor, "admin");
  return issueRefund(orderId);
}

async function issueRefund(orderId: string): Promise<Refund> {
  const charge = await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new InvalidTransitionError("refund", order.status);
    if (order.chargeId === undefined) throw new Error(`paid order ${order.id} has no charge`);
    order.status = "refunded";
    await tx.orders.save(order);
    return order.chargeId;
  });
  return stripe.refunds.create({ charge });
}
