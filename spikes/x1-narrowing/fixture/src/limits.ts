// Extra cases that probe the limits of narrowing-based from-state inference. Each
// `limitNN_*` function contains exactly one write to `status`. For some of them the
// checker's answer differs from the "semantic truth"; ../../cases.ts records both.

import { NotRefundable, type Order, type OrderRepo, type OrderStatus } from "./order.js";

// L01. Field typed as plain `string`: an equality guard still narrows to a literal.
interface LooseOrder {
  status: string;
}
export function limit01_stringGuarded(order: LooseOrder): void {
  if (order.status !== "paid") throw new NotRefundable(order.status);
  order.status = "refunded";
}

// L02. Field typed as plain `string`, no guard -> not a finite set.
export function limit02_stringUnguarded(order: LooseOrder): void {
  order.status = "refunded";
}

// L03. `any` entity.
// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped
export function limit03_any(order: any): void {
  if (order.status !== "paid") throw new NotRefundable(String(order.status));
  order.status = "refunded";
}

// L04. Generic entity type.
export function limit04_generic<T extends Order>(order: T): void {
  if (order.status !== "paid") throw new NotRefundable(order.status);
  order.status = "refunded";
}

// L05. TypeScript `enum` instead of a literal union.
export enum StatusEnum {
  Draft = "draft",
  Paid = "paid",
  Shipped = "shipped",
  Refunded = "refunded",
}
interface EnumOrder {
  status: StatusEnum;
}
export function limit05_tsEnum(order: EnumOrder): void {
  if (order.status !== StatusEnum.Paid) throw new NotRefundable(order.status);
  order.status = StatusEnum.Refunded;
}

// L06. Prisma-style generated enum: a const object plus a same-named type alias.
export const PrismaStatus = {
  draft: "draft",
  paid: "paid",
  shipped: "shipped",
  refunded: "refunded",
} as const;
export type PrismaStatus = (typeof PrismaStatus)[keyof typeof PrismaStatus];
interface PrismaOrder {
  id: string;
  status: PrismaStatus;
}
export function limit06_prismaEnum(order: PrismaOrder): PrismaOrder {
  if (order.status !== PrismaStatus.paid) throw new NotRefundable(order.status);
  return { ...order, status: PrismaStatus.refunded };
}

// L07. Status copied into a local first: the guard narrows `s`, not `order.status`.
export function limit07_localAlias(order: Order): void {
  const s = order.status;
  if (s !== "paid") throw new NotRefundable(s);
  order.status = "refunded";
}

// L08. Destructured status: same gap as L07.
export function limit08_destructured(order: Order): void {
  const { status } = order;
  if (status !== "paid") throw new NotRefundable(status);
  order.status = "refunded";
}

// L09. `Array.prototype.includes` guard: no narrowing.
const REFUNDABLE: readonly OrderStatus[] = ["paid", "shipped"];
export function limit09_includes(order: Order): void {
  if (!REFUNDABLE.includes(order.status)) throw new NotRefundable(order.status);
  order.status = "refunded";
}

// L10. Unannotated helper: TS >= 5.5 infers the type predicate `s is "paid"`.
function looksPaid(s: OrderStatus) {
  return s === "paid";
}
export function limit10_inferredPredicate(order: Order): void {
  if (!looksPaid(order.status)) throw new NotRefundable(order.status);
  order.status = "refunded";
}

// L11. Write in a closure created after the guard: property narrowing is dropped.
export function limit11_closureAfterGuard(order: Order, later: (fn: () => void) => void): void {
  if (order.status !== "paid") throw new NotRefundable(order.status);
  later(() => {
    order.status = "refunded";
  });
}

// L12. Narrowing survives an `await` (the value read, not the database state).
export async function limit12_acrossAwait(
  order: Order,
  charge: () => Promise<void>,
): Promise<void> {
  if (order.status !== "paid") throw new NotRefundable(order.status);
  await charge();
  order.status = "refunded";
}

// L13. The reference is reassigned between the guard and the write: narrowing is reset.
export async function limit13_reassigned(repo: OrderRepo, id: string): Promise<void> {
  let o = await repo.get(id);
  if (o.status !== "paid") throw new NotRefundable(o.status);
  o = await repo.get(id);
  o.status = "refunded";
}

// L14. Loop with `continue`.
export function limit14_loopContinue(orders: Order[]): void {
  for (const o of orders) {
    if (o.status !== "paid") continue;
    o.status = "refunded";
  }
}

// L15. Domain object: write through `this`.
export class limit15_OrderEntity {
  constructor(public status: OrderStatus) {}
  refund(): void {
    if (this.status !== "paid" && this.status !== "shipped") throw new NotRefundable(this.status);
    this.status = "refunded";
  }
}

// L16. `switch (true)` (TS >= 5.3).
export function limit16_switchTrue(order: Order): void {
  switch (true) {
    case order.status === "paid":
      order.status = "refunded";
      break;
    default:
      throw new NotRefundable(order.status);
  }
}

// L17. A call between guard and write mutates the order. TS keeps the narrowing (it does
// not invalidate property narrowings on calls), so the answer is unsound: truth is {draft}.
function reopen(o: Order): void {
  o.status = "draft";
}
export function limit17_mutatedByCall(order: Order): void {
  if (order.status !== "paid") throw new NotRefundable(order.status);
  reopen(order);
  order.status = "refunded";
}
