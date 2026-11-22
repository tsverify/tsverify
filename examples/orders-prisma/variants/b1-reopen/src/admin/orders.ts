import type { Actor } from "../auth/actor";
import { requireRole } from "../auth/guards";
import { prisma } from "../db";
import { InvalidTransitionError } from "../errors";
import type { Order } from "../generated/prisma/client";

/** An admin marks a paid order as shipped (a conditional update: still `paid`). */
export async function shipOrder(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  requireRole(ctx.actor, "admin");
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== "paid") throw new InvalidTransitionError("ship", order.status);
  return prisma.order.update({
    where: { id: orderId, status: "paid" },
    data: { status: "shipped" },
  });
}

/** An admin reopens a paid order so the customer can pay again (support tooling). */
export async function reopenOrder(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  requireRole(ctx.actor, "admin");
  return prisma.order.update({
    where: { id: orderId, status: "paid" },
    data: { status: "pending_payment" },
  });
}
