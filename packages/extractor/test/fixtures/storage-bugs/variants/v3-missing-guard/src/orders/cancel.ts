import type { Actor } from "../auth/guards";
import { loadOrder, saveOrder, withTransaction } from "../store";

/** BUG: no requireRole. */
export async function cancelOrder(_actor: Actor, id: string): Promise<void> {
  await withTransaction(async () => {
    const order = await loadOrder(id);
    if (order === undefined || order.status !== "pending") throw new Error("not pending");
    order.status = "cancelled";
    await saveOrder(order);
  });
}
