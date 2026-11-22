import { db } from "../../_lib/db";
import { requireRole } from "../../_lib/guards";
import type { Actor } from "../../_lib/order";

const ADMIN = "admin";

/** `requireRole(…, "support")` is not the `role(admin)` binding. */
export async function shipAsSupport(ctx: { actor: Actor }, orderId: string): Promise<void> {
  requireRole(ctx.actor, "support");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** A constant with a literal type matches like the literal itself. */
export async function shipAsAdminConst(ctx: { actor: Actor }, orderId: string): Promise<void> {
  requireRole(ctx.actor, ADMIN);
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}
