/** The app's own storage functions over a plain Map (bound in `bindings.storage`). */
export type Status = "pending" | "paid" | "shipped" | "refunded" | "cancelled";

export interface Order {
  id: string;
  status: Status;
  chargeId: string;
}

const orders = new Map<string, Order>();

export async function getOrder(id: string): Promise<Order | undefined> {
  const order = orders.get(id);
  return order === undefined ? undefined : { ...order };
}

export async function saveOrder(order: Order): Promise<void> {
  orders.set(order.id, { ...order });
}

/** Sets `to` only when the stored status is one of `from`. */
export async function setStatusIf(id: string, from: readonly Status[], to: Status): Promise<boolean> {
  const order = orders.get(id);
  if (order === undefined || !from.includes(order.status)) return false;
  orders.set(id, { ...order, status: to });
  return true;
}
