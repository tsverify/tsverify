import { writeAudit } from "./audit";
import { withTransaction } from "./db";
import { findOrder, setOrderStatusIf } from "./repo";

/** Ships a paid order. */
export async function shipOrder(ctx: { actor: string }, orderId: string): Promise<void> {
  await withTransaction(ctx, async (tx) => {
    const order = await findOrder(tx, orderId);
    if (order.status !== "paid") throw new Error(`order ${order.id} is ${order.status}`);
    if (!(await setOrderStatusIf(tx, order.id, "paid", "shipped"))) throw new Error("changed");
  });
}

/** Cancels a paid order, with an audit row written through the transaction itself. */
export async function cancelOrder(ctx: { actor: string }, orderId: string): Promise<void> {
  await withTransaction(ctx, async (tx) => {
    const order = await findOrder(tx, orderId);
    if (order.status !== "paid") throw new Error(`order ${order.id} is ${order.status}`);
    if (!(await setOrderStatusIf(tx, order.id, "paid", "canceled"))) throw new Error("changed");
    await writeAudit(tx, { orderId: order.id, action: "cancel" });
  });
}
