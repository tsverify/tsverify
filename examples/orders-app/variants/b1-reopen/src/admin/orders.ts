import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { db } from "../db";
import { InvalidTransitionError } from "../errors";
import type { Order } from "../orders/order";

/** An admin marks a paid order as shipped. */
export async function shipOrder(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  requireRole(ctx.actor, "admin");
  return db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new InvalidTransitionError("ship", order.status);
    order.status = "shipped";
    await tx.orders.save(order);
    return order;
  });
}

/** An admin puts a paid order back to awaiting payment, e.g. after the bank disputes the charge. */
export async function reopenOrder(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  requireRole(ctx.actor, "admin");
  return db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new InvalidTransitionError("reopen", order.status);
    order.status = "pending_payment";
    await tx.orders.save(order);
    return order;
  });
}
