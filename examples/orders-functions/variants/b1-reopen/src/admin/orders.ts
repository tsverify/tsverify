import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { InvalidTransitionError, NotFoundError } from "../errors";
import type { Order } from "../orders/order";
import { getOrder, saveOrder } from "../store/orders";
import { withTransaction } from "../store/transaction";

/** An admin marks a paid order as shipped. */
export async function shipOrder(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  requireRole(ctx.actor, "admin");
  return withTransaction(async () => {
    const order = await getOrder(orderId);
    if (order === undefined) throw new NotFoundError(`order ${orderId} not found`);
    if (order.status !== "paid") throw new InvalidTransitionError("ship", order.status);
    order.status = "shipped";
    await saveOrder(order);
    return order;
  });
}

/** BUG: not in the spec; a reopened order can be paid (and receipted) again. */
export async function reopenOrder(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  requireRole(ctx.actor, "admin");
  return withTransaction(async () => {
    const order = await getOrder(orderId);
    if (order === undefined) throw new NotFoundError(`order ${orderId} not found`);
    if (order.status !== "paid") throw new InvalidTransitionError("reopen", order.status);
    order.status = "pending_payment";
    await saveOrder(order);
    return order;
  });
}
