export type OrderStatus = "paid" | "shipped" | "canceled";

export interface Order {
  id: string;
  status: OrderStatus;
}
