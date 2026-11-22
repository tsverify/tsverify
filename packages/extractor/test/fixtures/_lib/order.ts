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
  status: OrderStatus;
  chargeId?: string;
}

export interface Actor {
  id: string;
  roles: readonly string[];
}
