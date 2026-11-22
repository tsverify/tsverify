import { db } from "../../_lib/db";
import { requireRole } from "../../_lib/guards";
import type { Actor } from "../../_lib/order";

export async function shipOrder(ctx: { actor: Actor }, orderId: string): Promise<void> {
  requireRole(ctx.actor, "admin");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** No spec transition's impl reaches this (B1's shape). */
export async function reopenOrder(ctx: { actor: Actor }, orderId: string): Promise<void> {
  requireRole(ctx.actor, "admin");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "pending_payment";
    await tx.orders.save(order);
  });
}

/** Two unlinked writes in one function: `resetOrder`, `resetOrder~2`. */
export async function resetOrder(orderId: string, hard: boolean): Promise<void> {
  const order = await db.orders.get(orderId);
  if (hard) order.status = "draft";
  else order.status = "pending_payment";
  await db.orders.save(order);
}
