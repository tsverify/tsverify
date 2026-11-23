import { db } from "../../_lib/db";
import type { Order, OrderStatus } from "../../_lib/order";

const NEXT: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["pending_payment", "cancelled"],
  pending_payment: ["paid", "cancelled"],
  paid: ["shipped", "refunded"],
  shipped: [],
  refunded: [],
  cancelled: [],
};

/** A lookup table: a check, but not one TypeScript narrows through. */
export async function refundByTable(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!NEXT[order.status].includes("refunded")) throw new Error("not allowed");
  order.status = "refunded";
  await db.orders.save(order);
}

function assertTransition(order: Order, to: OrderStatus): void {
  if (!NEXT[order.status].includes(to)) throw new Error("not allowed");
}

/** A helper that throws, given the whole entity. */
export async function refundByHelper(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  assertTransition(order, "refunded");
  order.status = "refunded";
  await db.orders.save(order);
}

/** The state only appears in a message: no check at all. */
export async function refundUnchecked(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (order.chargeId === undefined) throw new Error(`order ${order.id} is ${order.status}`);
  order.status = "refunded";
  await db.orders.save(order);
}
