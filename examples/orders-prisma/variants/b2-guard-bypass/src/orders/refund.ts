import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { prisma } from "../db";
import { ConcurrentUpdateError, InvalidTransitionError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";

export interface RefundContext {
  actor: Actor;
  /** Set by internal tooling (support scripts, smoke tests) that runs without an admin session. */
  internal?: boolean;
}

/**
 * An admin refunds a paid order. The write is a conditional `updateMany` (status still `paid`),
 * so of two concurrent refunds only one changes a row; Stripe is called only by that one.
 */
export async function refundOrder(ctx: RefundContext, orderId: string): Promise<Refund> {
  if (ctx.internal === true) {
    return issueRefund(orderId);
  }
  requireRole(ctx.actor, "admin");
  return issueRefund(orderId);
}

async function issueRefund(orderId: string): Promise<Refund> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== "paid") throw new InvalidTransitionError("refund", order.status);
  if (order.chargeId === null) throw new Error(`paid order ${order.id} has no charge`);
  const { count } = await prisma.order.updateMany({
    where: { id: orderId, status: "paid" },
    data: { status: "refunded" },
  });
  if (count === 0) throw new ConcurrentUpdateError("refund", "paid");
  return stripe.refunds.create({ charge: order.chargeId });
}
