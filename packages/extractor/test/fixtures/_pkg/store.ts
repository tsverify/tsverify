// Another package of the workspace, outside the project root and not in its tsconfig's include:
// in the program only because the project imports it.
import { db } from "../_lib/db";

/** A helper the impl calls: its write is the impl's. */
export async function markShipped(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (order.status !== "paid") throw new Error("not paid");
  order.status = "shipped";
  await db.orders.save(order);
}

/** The package's own write, which no impl reaches: not the project's to report. */
export async function forceRefund(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  order.status = "refunded";
  await db.orders.save(order);
}
