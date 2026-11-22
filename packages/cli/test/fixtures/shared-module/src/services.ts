import type { Actor, Parcel } from "./parcel";

const outbox: string[] = [];

/** The email client, bound as a bare function (`bindings.clients.email`). */
export async function sendMail(to: string, template: string): Promise<void> {
  outbox.push(`${to}:${template}`);
}

/** A guard exported beside the client: generated tests must keep it real. */
export function requireOwner(actor: Actor, parcel: Parcel): void {
  if (parcel.ownerId !== actor.id) throw new Error(`${actor.id} does not own ${parcel.id}`);
}
