/** The app's own storage functions, written over a plain Map (bindings.storage names them). */
export interface Order {
  id: string;
  status: "pending" | "paid" | "shipped" | "refunded";
  chargeId: string;
}

const orders = new Map<string, Order>();

/** Loads one order by key. */
export async function getOrder(id: string): Promise<Order | undefined> {
  const order = orders.get(id);
  return order === undefined ? undefined : { ...order };
}

/** Persists an order. */
export async function saveOrder(order: Order): Promise<void> {
  orders.set(order.id, { ...order });
}

/** Conditional save: sets `to` only when the stored status is one of `from`. */
export async function setStatusIf(
  id: string,
  from: Order["status"] | Order["status"][],
  to: Order["status"],
): Promise<boolean> {
  const order = orders.get(id);
  const allowed = Array.isArray(from) ? from : [from];
  if (order === undefined || !allowed.includes(order.status)) return false;
  orders.set(id, { ...order, status: to });
  return true;
}

/** Not a storage function tsverify knows about: it stays real in generated tests. */
export function orderCount(): number {
  return orders.size;
}
