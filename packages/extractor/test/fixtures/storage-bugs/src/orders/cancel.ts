import { type Actor, requireRole } from "../auth/guards";
import { loadOrder, saveOrder, withTransaction } from "../store";

export async function cancelOrder(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  await withTransaction(async () => {
    const order = await loadOrder(id);
    if (order === undefined || order.status !== "pending") throw new Error("not pending");
    order.status = "cancelled";
    await saveOrder(order);
  });
}
