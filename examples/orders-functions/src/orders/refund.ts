import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { InvalidTransitionError, NotFoundError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";
import { getOrder, saveOrder } from "../store/orders";
import { withTransaction } from "../store/transaction";

/**
 * An admin refunds a paid order. The status check and the save happen in one `withTransaction`,
 * so two concurrent refunds cannot both pass the check; Stripe is called only after it.
 */
export async function refundOrder(ctx: { actor: Actor }, orderId: string): Promise<Refund> {
  requireRole(ctx.actor, "admin");
  const charge = await withTransaction(async () => {
    const order = await getOrder(orderId);
    if (order === undefined) throw new NotFoundError(`order ${orderId} not found`);
    if (order.status !== "paid") throw new InvalidTransitionError("refund", order.status);
    if (order.chargeId === undefined) throw new Error(`paid order ${order.id} has no charge`);
    order.status = "refunded";
    await saveOrder(order);
    return order.chargeId;
  });
  return stripe.refunds.create({ charge });
}
