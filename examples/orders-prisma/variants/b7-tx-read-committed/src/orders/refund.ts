import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { prisma } from "../db";
import { InvalidTransitionError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";

/**
 * An admin refunds a paid order. The read, the status check and the write run in one interactive
 * transaction, at the database's default isolation level, so two concurrent refunds can still
 * both read `paid` and both write; Stripe is called after the commit.
 */
export async function refundOrder(ctx: { actor: Actor }, orderId: string): Promise<Refund> {
  requireRole(ctx.actor, "admin");
  const charge = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== "paid") throw new InvalidTransitionError("refund", order.status);
    if (order.chargeId === null) throw new Error(`paid order ${order.id} has no charge`);
    await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    return order.chargeId;
  });
  return stripe.refunds.create({ charge });
}
