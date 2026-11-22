import type { Actor } from "../auth/actor";
import { requireOwner } from "../auth/guards";
import { prisma } from "../db";
import { InvalidTransitionError } from "../errors";
import type { Order } from "../generated/prisma/client";

/**
 * The customer submits their draft order; it now awaits payment. The update repeats the status
 * check in its `where`, so it fails (P2025) if the order left `draft` after it was read.
 */
export async function checkout(ctx: { actor: Actor }, orderId: string): Promise<Order> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  requireOwner(ctx.actor, order);
  if (order.status !== "draft") throw new InvalidTransitionError("checkout", order.status);
  return prisma.order.update({
    where: { id: orderId, status: "draft" },
    data: { status: "pending_payment" },
  });
}
