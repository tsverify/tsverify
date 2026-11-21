import type { Actor } from "../auth/actor";
import { requireOwner } from "../auth/guards";
import { db } from "../db";
import { InvalidTransitionError } from "../errors";
import type { Order } from "./order";

/** The customer submits their draft order; it now awaits payment. */
export async function checkout(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  return db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    requireOwner(ctx.actor, order);
    if (order.status !== "draft") throw new InvalidTransitionError("checkout", order.status);
    order.status = "pending_payment";
    await tx.orders.save(order);
    return order;
  });
}
