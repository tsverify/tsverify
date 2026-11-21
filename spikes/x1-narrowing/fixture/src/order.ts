// Domain model for the X1 narrowing spike. The extractor only cares about `Order.status`.

export type OrderStatus =
  | "draft"
  | "pending_payment"
  | "paid"
  | "shipped"
  | "refunded"
  | "cancelled";

export interface Order {
  id: string;
  status: OrderStatus;
  chargeId?: string;
}

/** An order whose status is known to be "paid". Used by object-level predicates. */
export type PaidOrder = Order & { status: "paid" };

export interface OrderRepo {
  get(id: string): Promise<Order>;
  save(order: Order): Promise<void>;
}

export interface Tx {
  get(id: string): Promise<Order>;
  save(order: Order): Promise<void>;
}

export interface Db {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export class NotRefundable extends Error {}

// --- guard helpers -------------------------------------------------------------------

/** Assertion function on the status value. */
export function assertPaidStatus(status: OrderStatus): asserts status is "paid" {
  if (status !== "paid") throw new NotRefundable(status);
}

/** Assertion function on the whole order. */
export function assertPaidOrder(order: Order): asserts order is PaidOrder {
  if (order.status !== "paid") throw new NotRefundable(order.status);
}

/** Type predicate on the status value. */
export function isRefundableStatus(status: OrderStatus): status is "paid" | "shipped" {
  return status === "paid" || status === "shipped";
}

/** Type predicate on the whole order. */
export function isPaidOrder(order: Order): order is PaidOrder {
  return order.status === "paid";
}

/** Plain boolean helper: the checker cannot see through it (no type predicate). */
export function canRefund(order: Order): boolean {
  return order.status === "paid";
}
