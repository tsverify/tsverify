import { connection, type Tx } from "./db";
import type { Order, OrderStatus } from "./order";

/** Loads one order (generated tests replace it with a fake). */
export async function findOrder(_tx: Tx, id: string): Promise<Order> {
  throw new Error(`no order ${id} at ${connection.url}`);
}

/** Sets `to` while the stored status is `from` (generated tests replace it with a fake). */
export async function setOrderStatusIf(
  _tx: Tx,
  id: string,
  from: OrderStatus,
  to: OrderStatus,
): Promise<boolean> {
  throw new Error(`no order ${id} (${from} → ${to}) at ${connection.url}`);
}
