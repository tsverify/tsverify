/** A self-contained app whose state field is typed `string` (spike X1 L1/L2). */
export interface Ticket {
  id: string;
  status: string;
}

const rows = new Map<string, Ticket>();

export const store = {
  tickets: {
    async get(id: string): Promise<Ticket> {
      const t = rows.get(id);
      if (t === undefined) throw new Error(`no ticket ${id}`);
      return { ...t };
    },
    async save(ticket: Ticket): Promise<void> {
      rows.set(ticket.id, { ...ticket });
    },
  },
};

/** Unguarded: from-state `*`. */
export async function closeTicket(id: string): Promise<void> {
  const ticket = await store.tickets.get(id);
  ticket.status = "closed";
  await store.tickets.save(ticket);
}

/** Guarded: a string field still narrows to the literal. */
export async function resolveTicket(id: string): Promise<void> {
  const ticket = await store.tickets.get(id);
  if (ticket.status !== "open") return;
  ticket.status = "resolved";
  await store.tickets.save(ticket);
}
