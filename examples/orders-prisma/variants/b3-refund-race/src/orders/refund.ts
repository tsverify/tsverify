import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { prisma } from "../db";
import { InvalidTransitionError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";

/**
 * An admin refunds a paid order: read, check, refund at Stripe, then mark it refunded. The
 * update does not repeat the status check, so two concurrent refunds can both pass it.
 */
export async function refundOrder(ctx: { actor: Actor }, orderId: string): Promise<Refund> {
  requireRole(ctx.actor, "admin");
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== "paid") throw new InvalidTransitionError("refund", order.status);
  if (order.chargeId === null) throw new Error(`paid order ${order.id} has no charge`);
  const refund = await stripe.refunds.create({ charge: order.chargeId });
  await prisma.order.update({ where: { id: orderId }, data: { status: "refunded" } });
  return refund;
}
