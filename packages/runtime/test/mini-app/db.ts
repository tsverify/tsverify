// In-memory order repository. Plain application code: no test hooks.

export type OrderStatus = "pending_payment" | "paid" | "shipped" | "refunded" | "cancelled";

export interface Order {
  id: string;
  status: OrderStatus;
  chargeId: string;
  amount: number;
}

export interface OrdersRepo {
  get(id: string): Promise<Order | undefined>;
  save(order: Order): Promise<void>;
}

export interface Tx {
  orders: OrdersRepo;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async lock(): Promise<() => void> {
    let unlock: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    return unlock;
  }
}

const rows = new Map<string, Order>();
const txLock = new Mutex();

function repo(read: (id: string) => Order | undefined, write: (o: Order) => void): OrdersRepo {
  return {
    async get(id) {
      await Promise.resolve(); // simulated I/O hop
      const row = read(id);
      return row ? structuredClone(row) : undefined;
    },
    async save(order) {
      await Promise.resolve();
      write(structuredClone(order));
    },
  };
}

export const db = {
  orders: repo(
    (id) => rows.get(id),
    (o) => rows.set(o.id, o),
  ),

  /** Serializable transaction: one at a time, writes are applied on commit. */
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const unlock = await txLock.lock();
    try {
      const staged = new Map<string, Order>();
      const tx: Tx = {
        orders: repo(
          (id) => staged.get(id) ?? rows.get(id),
          (o) => staged.set(o.id, o),
        ),
      };
      const result = await fn(tx);
      for (const [id, o] of staged) rows.set(id, o);
      return result;
    } finally {
      unlock();
    }
  },
};
