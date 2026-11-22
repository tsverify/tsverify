import { db } from "../../_lib/db";
import type { Order, OrderStatus } from "../../_lib/order";

declare const seeded: Order;

/** Outside any function: not extracted, reported under the file's name. */
seeded.status = "paid";

/** Two non-literal writes in one function: one id each, the second suffixed. */
export async function setTwice(orderId: string, a: OrderStatus, b: OrderStatus): Promise<void> {
  const order = await db.orders.get(orderId);
  order.status = a;
  order.status = b;
  await db.orders.save(order);
}
