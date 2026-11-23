import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { InvalidTransitionError, NotFoundError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";
import { getOrder, saveOrder } from "../store/orders";

/** BUG: no withTransaction, and Stripe is called between the check and the save. */
export async function refundOrder(ctx: { actor: Actor }, orderId: string): Promise<Refund> {
  requireRole(ctx.actor, "admin");
  const order = await getOrder(orderId);
  if (order === undefined) throw new NotFoundError(`order ${orderId} not found`);
  if (order.status !== "paid") throw new InvalidTransitionError("refund", order.status);
  if (order.chargeId === undefined) throw new Error(`paid order ${order.id} has no charge`);
  const refund = await stripe.refunds.create({ charge: order.chargeId });
  order.status = "refunded";
  await saveOrder(order);
  return refund;
}
