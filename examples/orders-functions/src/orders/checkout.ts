import type { Actor } from "../auth/actor";
import { requireOwner } from "../auth/guards";
import { InvalidTransitionError, NotFoundError } from "../errors";
import { getOrder, saveOrder } from "../store/orders";
import { withTransaction } from "../store/transaction";
import type { Order } from "./order";

/** The customer submits their draft order; it now awaits payment. */
export async function checkout(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  return withTransaction(async () => {
    const order = await getOrder(orderId);
    if (order === undefined) throw new NotFoundError(`order ${orderId} not found`);
    requireOwner(ctx.actor, order);
    if (order.status !== "draft") throw new InvalidTransitionError("checkout", order.status);
    order.status = "pending_payment";
    await saveOrder(order);
    return order;
  });
}
