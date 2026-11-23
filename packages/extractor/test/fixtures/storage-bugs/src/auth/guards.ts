export interface Actor {
  id: string;
  roles: readonly string[];
}

export function requireRole(actor: Actor, role: string): void {
  if (!actor.roles.includes(role)) throw new Error(`${actor.id} is not ${role}`);
}
