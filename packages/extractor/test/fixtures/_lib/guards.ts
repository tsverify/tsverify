import type { Actor, Order } from "./order";

export function requireRole(actor: Actor, role: string): void {
  if (!actor.roles.includes(role)) throw new Error(`${actor.id} is not ${role}`);
}

export function requireOwner(actor: Actor, order: Order): void {
  if (order.ownerId !== actor.id) throw new Error(`${actor.id} does not own ${order.id}`);
}
