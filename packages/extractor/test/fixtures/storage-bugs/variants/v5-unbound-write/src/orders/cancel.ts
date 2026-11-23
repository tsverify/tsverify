import { type Actor, requireRole } from "../auth/guards";
import { loadOrder } from "../store";
import { patchOrderRow } from "../store/legacy";

/** BUG (for tsverify): the write goes through an unbound function. */
export async function cancelOrder(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  const order = await loadOrder(id);
  if (order === undefined || order.status !== "pending") throw new Error("not pending");
  await patchOrderRow(id, { status: "cancelled" });
}
