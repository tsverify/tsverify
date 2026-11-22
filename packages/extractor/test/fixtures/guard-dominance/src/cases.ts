import { db } from "../../_lib/db";
import { requireOwner, requireRole } from "../../_lib/guards";
import type { Actor } from "../../_lib/order";

interface Ctx {
  actor: Actor;
  internal?: boolean;
}

async function ship(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

// --- dominating ---------------------------------------------------------------------------

export async function guardBefore(ctx: Ctx, orderId: string): Promise<void> {
  requireRole(ctx.actor, "admin");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function guardInsideAfterRead(ctx: Ctx, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    requireOwner(ctx.actor, order);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function guardOnBothBranches(ctx: Ctx, other: Actor, orderId: string): Promise<void> {
  if (ctx.internal) requireRole(other, "admin");
  else requireRole(ctx.actor, "admin");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

function assertAdmin(ctx: Ctx): void {
  requireRole(ctx.actor, "admin");
}

export async function guardViaWrapper(ctx: Ctx, orderId: string): Promise<void> {
  assertAdmin(ctx);
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

async function shipGuardedOnly(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function guardBeforeHelper(ctx: Ctx, orderId: string): Promise<void> {
  requireRole(ctx.actor, "admin");
  await shipGuardedOnly(orderId);
}

// --- not dominating -----------------------------------------------------------------------

export async function guardOnOneBranch(ctx: Ctx, orderId: string): Promise<void> {
  if (!ctx.internal) requireRole(ctx.actor, "admin");
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function guardSwallowed(ctx: Ctx, orderId: string): Promise<void> {
  try {
    requireRole(ctx.actor, "admin");
  } catch {
    // ignored: the guard's throw does not stop the write
  }
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function guardAfterWrite(ctx: Ctx, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
  requireRole(ctx.actor, "admin");
}

/** B2's shape: one guarded and one unguarded call of the same helper. */
export async function guardBypassedByEarlyReturn(ctx: Ctx, orderId: string): Promise<void> {
  if (ctx.internal === true) {
    return ship(orderId);
  }
  requireRole(ctx.actor, "admin");
  return ship(orderId);
}
