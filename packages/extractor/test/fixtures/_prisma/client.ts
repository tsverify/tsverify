/**
 * A types-only stand-in for a generated Prisma client (`prisma generate` output), mirroring the
 * call shapes of `@prisma/client`: model delegates, `$transaction` (interactive and array forms),
 * `Prisma.TransactionIsolationLevel` and a string-literal enum like `$Enums`.
 */
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
  email: string;
  status: OrderStatus;
  chargeId: string | null;
}

export interface EnumOrderStatusFilter {
  equals?: OrderStatus;
  in?: OrderStatus[];
  notIn?: OrderStatus[];
  not?: OrderStatus | EnumOrderStatusFilter;
}

export interface OrderWhereInput {
  AND?: OrderWhereInput | OrderWhereInput[];
  OR?: OrderWhereInput[];
  NOT?: OrderWhereInput | OrderWhereInput[];
  id?: string;
  ownerId?: string;
  status?: OrderStatus | EnumOrderStatusFilter;
  chargeId?: string | null;
}

export type OrderWhereUniqueInput = { id: string } & Omit<OrderWhereInput, "id">;

export interface OrderUpdateInput {
  ownerId?: string;
  email?: string;
  status?: OrderStatus | { set?: OrderStatus };
  chargeId?: string | null | { set?: string | null };
}

export interface OrderCreateInput {
  id?: string;
  ownerId: string;
  email: string;
  status?: OrderStatus;
  chargeId?: string | null;
}

export interface BatchPayload {
  count: number;
}

export interface PrismaPromise<T> extends Promise<T> {
  readonly [Symbol.toStringTag]: "PrismaPromise";
}

export interface OrderDelegate {
  findUnique(args: { where: OrderWhereUniqueInput }): PrismaPromise<Order | null>;
  findUniqueOrThrow(args: { where: OrderWhereUniqueInput }): PrismaPromise<Order>;
  findFirst(args?: { where?: OrderWhereInput }): PrismaPromise<Order | null>;
  findFirstOrThrow(args?: { where?: OrderWhereInput }): PrismaPromise<Order>;
  update(args: { where: OrderWhereUniqueInput; data: OrderUpdateInput }): PrismaPromise<Order>;
  updateMany(args: { where?: OrderWhereInput; data: OrderUpdateInput }): PrismaPromise<BatchPayload>;
  upsert(args: {
    where: OrderWhereUniqueInput;
    create: OrderCreateInput;
    update: OrderUpdateInput;
  }): PrismaPromise<Order>;
  create(args: { data: OrderCreateInput }): PrismaPromise<Order>;
}

/** A second model with its own `status`: its writes are not `Order` transitions. */
export interface RefundLogDelegate {
  update(args: {
    where: { id: string };
    data: { status?: "pending" | "done" };
  }): PrismaPromise<{ id: string; status: "pending" | "done" }>;
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

export type TransactionClient = Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect">;

export declare class PrismaClient {
  readonly order: OrderDelegate;
  readonly refundLog: RefundLogDelegate;
  $transaction<R>(fn: (tx: TransactionClient) => Promise<R>, options?: TransactionOptions): Promise<R>;
  $transaction<P extends PrismaPromise<unknown>[]>(
    arg: [...P],
    options?: { isolationLevel?: TransactionIsolationLevel },
  ): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
}
