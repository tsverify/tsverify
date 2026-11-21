/** Lifecycle state of an order. Mirrors `entity.states` in order.behavior.yaml. */
export type OrderStatus =
  | "draft"
  | "pending_payment"
  | "paid"
  | "shipped"
  | "refunded"
  | "cancelled";

export interface Order {
  id: string;
  ownerId: string;
  /** Where the receipt is sent. */
  email: string;
  status: OrderStatus;
  /** Set when the payment succeeds; a refund goes against this charge. */
  chargeId?: string;
}
