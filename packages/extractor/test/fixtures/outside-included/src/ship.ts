import { db } from "../../_lib/db";
import { forceRefund, markShipped } from "../../_pkg/store";

export async function ship(orderId: string): Promise<void> {
  await markShipped(orderId);
}

export const refunds = { forceRefund };

/** A write of the project's own that no spec transition declares: still reported. */
export async function cancelHere(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  order.status = "cancelled";
  await db.orders.save(order);
}
