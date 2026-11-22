import { ForbiddenError } from "../errors";
import type { Order } from "../generated/prisma/client";
import type { Actor, Role } from "./actor";

/** Throws unless the actor owns the order. */
export function requireOwner(actor: Actor, order: Order): void {
  if (order.ownerId !== actor.id) {
    throw new ForbiddenError(`${actor.id} does not own order ${order.id}`);
  }
}

/** Throws unless the actor has the role. */
export function requireRole(actor: Actor, role: Role): void {
  if (!actor.roles.includes(role)) {
    throw new ForbiddenError(`${actor.id} is not ${role}`);
  }
}
