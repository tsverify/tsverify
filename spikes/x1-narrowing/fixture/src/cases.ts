// The required X1 guard styles. Each `caseNN_*` function contains exactly one write to
// `status` (an assignment `x.status = …` or an object-literal property `status: …`).
// The expected from-sets live in ../../cases.ts next to run.ts.

import {
  assertPaidOrder,
  assertPaidStatus,
  canRefund,
  type Db,
  isPaidOrder,
  isRefundableStatus,
  NotRefundable,
  type Order,
  type OrderRepo,
} from "./order.js";

// 1. if (…) throw
export function case01_ifThrow(order: Order): void {
  if (order.status !== "paid") throw new NotRefundable(order.status);
  order.status = "refunded";
}

// 2. switch
export function case02_switch(order: Order): void {
  switch (order.status) {
    case "paid":
      order.status = "refunded";
      break;
    default:
      throw new NotRefundable(order.status);
  }
}

// 3. early return for the other states
export function case03_earlyReturn(order: Order): void {
  if (order.status === "draft" || order.status === "pending_payment") return;
  if (order.status === "cancelled" || order.status === "refunded") return;
  order.status = "refunded";
}

// 4a. assertion function on the status value
export function case04a_assertStatus(order: Order): void {
  assertPaidStatus(order.status);
  order.status = "refunded";
}

// 4b. assertion function on the whole order (mutation would not type-check, so write by spread)
export async function case04b_assertOrder(order: Order, repo: OrderRepo): Promise<void> {
  assertPaidOrder(order);
  await repo.save({ ...order, status: "refunded" });
}

// 5. conditional (ternary) expression path
export function case05_ternary(order: Order): Order {
  return order.status === "paid" ? { ...order, status: "refunded" } : order;
}

// 6. negative case: plain boolean helper, no type predicate -> unconstrained
export function case06_booleanHelper(order: Order): void {
  if (!canRefund(order)) throw new NotRefundable(order.status);
  order.status = "refunded";
}

// 7a. type predicate on the status value
export function case07a_predicateStatus(order: Order): void {
  if (!isRefundableStatus(order.status)) throw new NotRefundable(order.status);
  order.status = "refunded";
}

// 7b. type predicate on the whole order
export async function case07b_predicateOrder(order: Order, repo: OrderRepo): Promise<void> {
  if (isPaidOrder(order)) {
    await repo.save({ ...order, status: "refunded" });
  }
}

// 8. aliased condition (TS >= 4.4). TS only inlines `ok` when the narrowed reference is
// constant: a const/unassigned parameter AND a readonly property. `Order.status` is mutable,
// so the checker does NOT narrow here (see 8b).
export function case08_aliasedCondition(order: Order): void {
  const ok = order.status === "paid";
  if (!ok) throw new NotRefundable(order.status);
  order.status = "refunded";
}

// 8b. aliased condition on a readonly reference: TS inlines the alias and narrows.
export function case08b_aliasedReadonly(order: Readonly<Order>): Order {
  const ok = order.status === "paid";
  if (!ok) throw new NotRefundable(order.status);
  return { ...order, status: "refunded" };
}

// 9. multiple allowed states
export function case09_multipleStates(order: Order): void {
  if (order.status !== "paid" && order.status !== "shipped") throw new NotRefundable(order.status);
  order.status = "refunded";
}

// 10. write inside a transaction callback
export async function case10_callback(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const o = await tx.get(id);
    if (o.status !== "paid") throw new NotRefundable(o.status);
    o.status = "refunded";
    await tx.save(o);
  });
}

// 11. write via object spread to a save call
export async function case11_spreadSave(order: Order, repo: OrderRepo): Promise<void> {
  if (order.status !== "paid") throw new NotRefundable(order.status);
  await repo.save({ ...order, status: "refunded" });
}
