import { db, type OrderRepository, type Transaction } from "../../_lib/db";
import type { Order } from "../../_lib/order";

function loadOrder(tx: Transaction, id: string): Promise<Order> {
  return tx.orders.get(id);
}

async function loadAwaited(tx: Transaction, id: string): Promise<Order> {
  return await tx.orders.get(id);
}

async function loadViaConst(tx: Transaction, id: string): Promise<Order | undefined> {
  if (id === "") return undefined;
  const order = await tx.orders.get(id);
  return order;
}

function loadNested(tx: Transaction, id: string): Promise<Order> {
  return loadOrder(tx, id);
}

function fromRepo(repo: OrderRepository, id: string): Promise<Order> {
  return repo.get(id);
}

/** The read is the helper's return: atomic inside the transaction. */
export async function shipDirect(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await loadOrder(tx, orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function shipAwaited(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await loadAwaited(tx, orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function shipViaConst(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await loadViaConst(tx, orderId);
    if (order?.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** Two helper levels, and a repository member chain (`tx.orders`) passed as the argument. */
export async function shipNested(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await loadNested(tx, orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function shipRepo(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await fromRepo(tx.orders, orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** The helper is called with the root client inside the callback: the read bypasses the scope. */
export async function shipWithRoot(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await loadOrder(db, orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** No scope at all: the read is found (no warning), and the write is not atomic. */
export async function shipOutside(orderId: string): Promise<void> {
  const order = await loadOrder(db, orderId);
  if (order.status !== "paid") throw new Error("not paid");
  order.status = "shipped";
  await db.orders.save(order);
}
