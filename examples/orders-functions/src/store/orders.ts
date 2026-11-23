import { roundTrip } from "../fakes/round-trip";
import type { Order, OrderStatus } from "../orders/order";

/**
 * The app's own data layer: orders in a plain `Map`, behind four functions. No ORM. Every read
 * and write is a copy, and each call waits a round trip first, like a database would.
 *
 * `bindings.storage` in order.behavior.yaml names these functions, so tsverify treats them as the
 * storage boundary and never looks inside.
 */
const rows = new Map<string, Order>();

/** Loads a copy of the order, or `undefined` when there is none. */
export async function getOrder(id: string): Promise<Order | undefined> {
  await roundTrip();
  const row = rows.get(id);
  return row === undefined ? undefined : { ...row };
}

/** Stores a copy of the order, inserting or replacing it. */
export async function saveOrder(order: Order): Promise<void> {
  await roundTrip();
  rows.set(order.id, { ...order });
}

/**
 * Conditional save: when the stored status is one of `from`, sets `to` and merges `patch` (`{}`
 * to change the status only), in one step: nothing can run between the check and the write.
 * Returns a copy of the updated order, or `undefined` when the status was not one of `from` (or
 * there is no such order).
 */
export async function updateStatusIf(
  id: string,
  from: OrderStatus | readonly OrderStatus[],
  to: OrderStatus,
  patch: Partial<Omit<Order, "id" | "status">>,
): Promise<Order | undefined> {
  await roundTrip();
  const row = rows.get(id);
  const allowed: readonly OrderStatus[] = typeof from === "string" ? [from] : from;
  if (row === undefined || !allowed.includes(row.status)) return undefined;
  const updated = { ...row, ...patch, status: to };
  rows.set(id, updated);
  return { ...updated };
}

/** Removes every order. Test support. */
export function resetOrders(): void {
  rows.clear();
}
