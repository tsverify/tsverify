import { db } from "../../_lib/db";
import { requireRole } from "../../_lib/guards";
import type { Actor } from "../../_lib/order";

interface Ctx {
  actor: Actor;
  flags: Record<string, boolean>;
}

/** Seven independent optional guards: 2^7 = 128 guard sets, over the cap of 64. */
export async function manyOptionalGuards(ctx: Ctx, orderId: string): Promise<void> {
  if (ctx.flags.a) requireRole(ctx.actor, "a");
  if (ctx.flags.b) requireRole(ctx.actor, "b");
  if (ctx.flags.c) requireRole(ctx.actor, "c");
  if (ctx.flags.d) requireRole(ctx.actor, "d");
  if (ctx.flags.e) requireRole(ctx.actor, "e");
  if (ctx.flags.f) requireRole(ctx.actor, "f");
  if (ctx.flags.g) requireRole(ctx.actor, "g");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** Six optional guards: 2^6 = 64 sets, exactly the cap. */
export async function sixOptionalGuards(ctx: Ctx, orderId: string): Promise<void> {
  if (ctx.flags.a) requireRole(ctx.actor, "a");
  if (ctx.flags.b) requireRole(ctx.actor, "b");
  if (ctx.flags.c) requireRole(ctx.actor, "c");
  if (ctx.flags.d) requireRole(ctx.actor, "d");
  if (ctx.flags.e) requireRole(ctx.actor, "e");
  if (ctx.flags.f) requireRole(ctx.actor, "f");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}
