export interface Actor {
  id: string;
  roles: readonly string[];
}

export function requireRole(actor: Actor, role: string): void {
  if (!actor.roles.includes(role)) throw new Error(`${actor.id} is not ${role}`);
}

export function requireOwner(actor: Actor, order: { id: string; ownerId: string }): void {
  if (order.ownerId !== actor.id) throw new Error(`${actor.id} does not own ${order.id}`);
}
