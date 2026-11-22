/**
 * Stand-in for the client `prisma generate` writes from `prisma/schema.prisma` (the `prisma-client`
 * generator with `output = "../src/generated/prisma"`). It mirrors the generated client's public
 * shapes for the `Order` model: the model type, the `OrderStatus` enum (an object plus a
 * string-literal union, like `$Enums`), the model delegate (`findUnique`, `findUniqueOrThrow`,
 * `findFirst`, `update`, `updateMany`, …), `$transaction` in both forms, and
 * `Prisma.TransactionIsolationLevel`.
 *
 * In a real app this module talks to PostgreSQL. Here it is a tiny in-memory implementation, so
 * the example runs with no database: each operation waits a few microtask ticks (like a network
 * round trip) and then runs in one synchronous step, so `updateMany` with a status in `where` is a
 * compare-and-set, as in SQL. Interactive transactions are serialized only at the `Serializable`
 * isolation level; at the default level they take no lock, like READ COMMITTED.
 *
 * `tsv` never runs or reads this implementation: it recognizes the call shapes on the client
 * bound in `bindings.clients`, and generated tests replace `src/db.ts` with `@tsverify/runtime`'s fake.
 */
import { roundTrip } from "../../fakes/round-trip";

export const OrderStatus = {
  draft: "draft",
  pending_payment: "pending_payment",
  paid: "paid",
  shipped: "shipped",
  refunded: "refunded",
  cancelled: "cancelled",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const $Enums = { OrderStatus };

export interface Order {
  id: string;
  ownerId: string;
  /** Where the receipt is sent. */
  email: string;
  status: OrderStatus;
  /** Set when the payment succeeds; a refund goes against this charge. */
  chargeId: string | null;
}

export interface EnumOrderStatusFilter {
  equals?: OrderStatus;
  in?: OrderStatus[];
  notIn?: OrderStatus[];
  not?: OrderStatus;
}

export interface OrderWhereInput {
  id?: string;
  ownerId?: string;
  status?: OrderStatus | EnumOrderStatusFilter;
  chargeId?: string | null;
}

/** Prisma 5+: a unique filter may name non-unique fields too (`{ id, status }`). */
export type OrderWhereUniqueInput = { id: string } & Omit<OrderWhereInput, "id">;

export interface OrderUpdateInput {
  ownerId?: string;
  email?: string;
  status?: OrderStatus | { set: OrderStatus };
  chargeId?: string | null | { set: string | null };
}

export interface OrderCreateInput {
  id: string;
  ownerId: string;
  email: string;
  status?: OrderStatus;
  chargeId?: string | null;
}

export interface BatchPayload {
  count: number;
}

/** The generated client's promise type (lazy in Prisma; eager here, which awaiting code cannot tell). */
export type PrismaPromise<T> = Promise<T>;

export interface OrderDelegate {
  findUnique(args: { where: OrderWhereUniqueInput }): PrismaPromise<Order | null>;
  findUniqueOrThrow(args: { where: OrderWhereUniqueInput }): PrismaPromise<Order>;
  findFirst(args?: { where?: OrderWhereInput }): PrismaPromise<Order | null>;
  findMany(args?: { where?: OrderWhereInput }): PrismaPromise<Order[]>;
  create(args: { data: OrderCreateInput }): PrismaPromise<Order>;
  update(args: { where: OrderWhereUniqueInput; data: OrderUpdateInput }): PrismaPromise<Order>;
  updateMany(args: {
    where?: OrderWhereInput;
    data: OrderUpdateInput;
  }): PrismaPromise<BatchPayload>;
  deleteMany(args?: { where?: OrderWhereInput }): PrismaPromise<BatchPayload>;
}

export const Prisma = {
  TransactionIsolationLevel: {
    ReadUncommitted: "ReadUncommitted",
    ReadCommitted: "ReadCommitted",
    RepeatableRead: "RepeatableRead",
    Serializable: "Serializable",
  },
} as const;
export type TransactionIsolationLevel =
  (typeof Prisma.TransactionIsolationLevel)[keyof typeof Prisma.TransactionIsolationLevel];

export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: TransactionIsolationLevel;
}

/** What an interactive transaction's callback receives: the client without `$transaction`. */
export type TransactionClient = Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">;

/** Like Prisma's `PrismaClientKnownRequestError`; `P2025` = no record matched. */
export class PrismaClientKnownRequestError extends Error {
  override readonly name = "PrismaClientKnownRequestError";
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// --- the in-memory engine --------------------------------------------------------------------

function matches(order: Order, where: OrderWhereInput | undefined): boolean {
  for (const [field, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;
    const value = order[field as keyof Order];
    if (typeof cond !== "object" || cond === null) {
      if (value !== cond) return false;
      continue;
    }
    const f = cond as EnumOrderStatusFilter;
    if (f.equals !== undefined && value !== f.equals) return false;
    if (f.in !== undefined && !f.in.includes(value as OrderStatus)) return false;
    if (f.notIn?.includes(value as OrderStatus)) return false;
    if (f.not !== undefined && value === f.not) return false;
  }
  return true;
}

function applied(order: Order, data: OrderUpdateInput): Order {
  const next: Record<string, unknown> = { ...order };
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined) continue;
    next[field] = typeof value === "object" && value !== null ? value.set : value;
  }
  return next as unknown as Order;
}

function notFound(where: unknown): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError(
    `No record was found for an operation (where ${JSON.stringify(where)}).`,
    "P2025",
  );
}

class Mutex {
  private last: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.last;
    let release = (): void => {};
    this.last = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function orderDelegate(rows: Map<string, Order>): OrderDelegate {
  const find = (where: OrderWhereInput | undefined) =>
    [...rows.values()].filter((o) => matches(o, where));
  return {
    async findUnique({ where }) {
      await roundTrip();
      const [order] = find(where);
      return order === undefined ? null : { ...order };
    },
    async findUniqueOrThrow({ where }) {
      await roundTrip();
      const [order] = find(where);
      if (order === undefined) throw notFound(where);
      return { ...order };
    },
    async findFirst(args) {
      await roundTrip();
      const [order] = find(args?.where);
      return order === undefined ? null : { ...order };
    },
    async findMany(args) {
      await roundTrip();
      return find(args?.where).map((o) => ({ ...o }));
    },
    async create({ data }) {
      await roundTrip();
      const order: Order = { status: "draft", chargeId: null, ...data };
      rows.set(order.id, order);
      return { ...order };
    },
    async update({ where, data }) {
      await roundTrip();
      const [order] = find(where);
      if (order === undefined) throw notFound(where);
      const next = applied(order, data);
      rows.set(next.id, next);
      return { ...next };
    },
    async updateMany({ where, data }) {
      await roundTrip();
      const matched = find(where);
      for (const order of matched) rows.set(order.id, applied(order, data));
      return { count: matched.length };
    },
    async deleteMany(args) {
      await roundTrip();
      const matched = find(args?.where);
      for (const order of matched) rows.delete(order.id);
      return { count: matched.length };
    },
  };
}

export class PrismaClient {
  readonly order: OrderDelegate;
  private readonly serializable = new Mutex();

  constructor() {
    this.order = orderDelegate(new Map());
  }

  /** Interactive transaction: `fn` gets a transaction client. Serialized only when Serializable. */
  $transaction<R>(
    fn: (tx: TransactionClient) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R>;
  /** Array form: runs the operations in order and resolves with their results. */
  $transaction<P extends PrismaPromise<unknown>[]>(
    operations: [...P],
    options?: { isolationLevel?: TransactionIsolationLevel },
  ): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
  async $transaction(
    arg: ((tx: TransactionClient) => Promise<unknown>) | PrismaPromise<unknown>[],
    options?: TransactionOptions,
  ): Promise<unknown> {
    const run = async () => {
      if (typeof arg !== "function") return Promise.all(arg);
      const tx: TransactionClient = { order: this.order };
      return arg(tx);
    };
    return options?.isolationLevel === "Serializable" ? this.serializable.run(run) : run();
  }

  async $connect(): Promise<void> {}

  async $disconnect(): Promise<void> {}
}
