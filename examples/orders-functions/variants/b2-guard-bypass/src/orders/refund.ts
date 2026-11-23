import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { InvalidTransitionError, NotFoundError } from "../errors";
import { type Refund, stripe } from "../payments/stripe";
import { getOrder, saveOrder } from "../store/orders";
import { withTransaction } from "../store/transaction";

/** The transaction and the Stripe call, unchanged. */
async function issueRefund(orderId: string): Promise<Refund> {
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

/** BUG: an "internal" caller skips the admin check. */
export async function refundOrder(
  ctx: { actor: Actor; internal?: boolean },
  orderId: string,
): Promise<Refund> {
  if (ctx.internal) return issueRefund(orderId);
  requireRole(ctx.actor, "admin");
  return issueRefund(orderId);
}
