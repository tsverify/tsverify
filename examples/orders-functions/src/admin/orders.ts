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
