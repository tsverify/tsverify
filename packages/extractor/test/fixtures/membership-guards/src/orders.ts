import { db } from "../../_lib/db";
import type { OrderStatus } from "../../_lib/order";
import { SHIPPABLE } from "./states";

const ALLOWED = new Set(["paid", "shipped"]);
const REFUNDABLE = ["paid", "shipped"] as const;
let mutable = ["paid"];

/** An inline literal array, negated, then throw. */
export async function inlineThrow(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!["paid", "shipped"].includes(order.status)) throw new Error("not refundable");
  order.status = "refunded";
  await db.orders.save(order);
}

/** A `const` `Set` of literals, negated, then return. */
export async function setHasReturn(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!ALLOWED.has(order.status)) return;
  order.status = "refunded";
  await db.orders.save(order);
}

/** The `as const` array form, widened for `.includes`. */
export async function asConstWidened(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!(REFUNDABLE as readonly string[]).includes(order.status)) throw new Error("no");
  order.status = "refunded";
  await db.orders.save(order);
}

/** The `as const` array form, argument cast to the element type. */
export async function asConstCastArg(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!REFUNDABLE.includes(order.status as (typeof REFUNDABLE)[number])) throw new Error("no");
  order.status = "refunded";
  await db.orders.save(order);
}

/** The write inside the true branch, in a transaction, through an imported `const`. */
export async function insideTrueBranch(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (SHIPPABLE.includes(order.status)) {
      order.status = "shipped";
      await tx.orders.save(order);
    }
  });
}

/** Combined with an equality check that TS narrows: both apply. */
export async function withEquality(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!["paid", "shipped", "draft"].includes(order.status) || order.status === "draft") {
    throw new Error("no");
  }
  order.status = "refunded";
  await db.orders.save(order);
}

/** The else branch of a positive test: the excluded states remain. */
export async function elseBranch(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  const terminal: OrderStatus[] = [];
  if (["shipped", "refunded", "cancelled"].includes(order.status)) {
    terminal.push(order.status);
  } else {
    order.status = "cancelled";
    await db.orders.save(order);
  }
}

/** Not a guard: a `let` array may change. */
export async function mutableList(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!mutable.includes(order.status)) throw new Error("no");
  order.status = "refunded";
  await db.orders.save(order);
  mutable = [];
}

/** Not a guard on this entity: another order's status. */
export async function otherEntity(orderId: string, otherId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  const other = await db.orders.get(otherId);
  if (!["paid"].includes(other.status)) throw new Error("no");
  order.status = "refunded";
  await db.orders.save(order);
}

/** Not a guard: the negative test does not exit. */
export async function noExit(orderId: string, log: string[]): Promise<void> {
  const order = await db.orders.get(orderId);
  if (!["paid"].includes(order.status)) log.push("odd");
  order.status = "refunded";
  await db.orders.save(order);
}
