import { db, type Transaction } from "../../_lib/db";
import type { Order, OrderStatus } from "../../_lib/order";

/** Typed with exactly the spec's status union, but an event record, not the entity. */
export interface StatusChangedEvent {
  orderId: string;
  status: OrderStatus;
}

declare function publish(event: StatusChangedEvent): void;
declare function publishOrder(order: Order): void;

/** Assignment to an event's status: not a write of the entity. */
export function announceShipped(event: StatusChangedEvent): void {
  event.status = "shipped";
  publish(event);
}

/** Spread of an event passed to a call: not a write of the entity. */
export function announceRefunded(base: StatusChangedEvent): void {
  publish({ ...base, status: "refunded" });
}

/** Another type name with the same union, but produced by a bound read (through a helper). */
export interface OrderRecord {
  id: string;
  status: OrderStatus;
}

function loadRecord(tx: Transaction, id: string): Promise<OrderRecord> {
  return tx.orders.get(id);
}

export async function shipRecord(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order: OrderRecord = await loadRecord(tx, orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order as Order);
  });
}

/** Aliases of `Pick<Order, …>` and `Readonly<Order>` answer to the entity's name. */
type OrderRow = Pick<Order, "id" | "status">;
type Shipment = OrderRow;
type FrozenOrder = Readonly<Order>;

export function shipRow(row: Shipment): void {
  if (row.status !== "paid") return;
  row.status = "shipped";
}

export function refundFrozen(order: FrozenOrder): void {
  if (order.status !== "paid") return;
  publishOrder({ ...order, status: "refunded" });
}
