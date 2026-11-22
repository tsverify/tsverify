import type { Order } from "./order";

export interface OrderRepository {
  get(id: string): Promise<Order>;
  save(order: Order): Promise<void>;
}

export interface Transaction {
  readonly orders: OrderRepository;
}

export interface Database extends Transaction {
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

const rows = new Map<string, Order>();

const orders: OrderRepository = {
  async get(id) {
    const order = rows.get(id);
    if (order === undefined) throw new Error(`no order ${id}`);
    return { ...order };
  },
  async save(order) {
    rows.set(order.id, { ...order });
  },
};

export const db: Database = {
  orders,
  async transaction(fn) {
    return fn({ orders });
  },
};
