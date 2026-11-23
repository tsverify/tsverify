import { type Actor, requireRole } from "../auth/guards";
import { loadOrder, saveOrder, withTransaction } from "../store";

/** Reads, checks and saves: a helper the impl calls. */
export async function shipPaid(id: string): Promise<void> {
  const order = await loadOrder(id);
  if (order === undefined || order.status !== "paid") throw new Error("not paid");
  order.status = "shipped";
  await saveOrder(order);
}

/** The helper runs inside the atomic function. */
export async function shipOrder(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  await withTransaction(() => shipPaid(id));
}
