import { type Actor, requireRole } from "../auth/guards";
import { loadOrder, saveOrder } from "../store";

/** BUG: the read and the save are not one step. */
export async function shipOrder(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  const order = await loadOrder(id);
  if (order === undefined || order.status !== "paid") throw new Error("not paid");
  order.status = "shipped";
  await saveOrder(order);
}
