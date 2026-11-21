import { NotFoundError } from "./errors";
import type { Order } from "./orders/order";

/** Async access to stored orders. Every read and write is a copy, like a database round trip. */
export interface OrderRepository {
  /** Returns a copy of the stored order. Throws `NotFoundError` if there is none. */
  get(id: string): Promise<Order>;
  /** Stores a copy of the order, inserting or replacing it. */
  save(order: Order): Promise<void>;
}

/** The view of the database inside `db.transaction`. */
export interface Transaction {
  readonly orders: OrderRepository;
}

export interface Database extends Transaction {
  /**
   * Runs `fn` with exclusive access: transactions are serialized by a mutex, so a status check
   * and the write that depends on it cannot interleave with another transaction. Writes made
   * through `tx` are committed when `fn` resolves and discarded if it throws. Not reentrant.
   *
   * `db.orders` outside a transaction does not take the mutex.
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Removes every order. Test support. */
  reset(): void;
}

function copy(order: Order): Order {
  return { ...order };
}

export function createDatabase(): Database {
  const rows = new Map<string, Order>();
  let lastTransaction: Promise<void> = Promise.resolve();

  function read(id: string, staged?: Map<string, Order>): Order {
    const order = staged?.get(id) ?? rows.get(id);
    if (order === undefined) throw new NotFoundError(`order ${id} not found`);
    return copy(order);
  }

  return {
    orders: {
      async get(id) {
        return read(id);
      },
      async save(order) {
        rows.set(order.id, copy(order));
      },
    },

    async transaction(fn) {
      const previous = lastTransaction;
      let release = (): void => {};
      lastTransaction = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const staged = new Map<string, Order>();
        const result = await fn({
          orders: {
            async get(id) {
              return read(id, staged);
            },
            async save(order) {
              staged.set(order.id, copy(order));
            },
          },
        });
        for (const [id, order] of staged) rows.set(id, order);
        return result;
      } finally {
        release();
      }
    },

    reset() {
      rows.clear();
    },
  };
}

export const db = createDatabase();
