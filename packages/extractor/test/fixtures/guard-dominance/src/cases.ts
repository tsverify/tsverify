import { audit } from "../../_lib/clients";
import { db } from "../../_lib/db";
import { requireOwner, requireRole } from "../../_lib/guards";
import type { Actor, Order } from "../../_lib/order";

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

// --- guard sets ---------------------------------------------------------------------------

function isAdmin(actor: Actor): boolean {
  return actor.roles.includes("admin");
}

export async function adminOrOwner(ctx: Ctx, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (isAdmin(ctx.actor)) requireRole(ctx.actor, "admin");
    else requireOwner(ctx.actor, order);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

export async function adminAndOwner(ctx: Ctx, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    requireRole(ctx.actor, "admin");
    requireOwner(ctx.actor, order);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

async function shipAsOwner(ctx: Ctx, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    requireOwner(ctx.actor, order);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** The helper's own guard on every call; the caller's on one call path only. */
export async function adminThenHelperOwner(ctx: Ctx, orderId: string): Promise<void> {
  if (ctx.internal) {
    requireRole(ctx.actor, "admin");
    await shipAsOwner(ctx, orderId);
    return;
  }
  await shipAsOwner(ctx, orderId);
}

function assertAdminOrOwner(ctx: Ctx, order: Order): void {
  if (isAdmin(ctx.actor)) requireRole(ctx.actor, "admin");
  else requireOwner(ctx.actor, order);
}

/** A wrapper that passes one guard or the other contributes each alternative. */
export async function viaEitherWrapper(ctx: Ctx, orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    assertAdminOrOwner(ctx, order);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** A guard inside `try` whose `catch` rethrows still passes on every path that goes on. */
export async function guardRethrown(ctx: Ctx, orderId: string): Promise<void> {
  try {
    requireRole(ctx.actor, "admin");
  } catch (err) {
    await audit.log("denied");
    throw err;
  }
  await ship(orderId);
}
