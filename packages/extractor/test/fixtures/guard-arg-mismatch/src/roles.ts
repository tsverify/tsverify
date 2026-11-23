import { db } from "../../_lib/db";
import type { Actor } from "../../_lib/order";

/** A guard taking a list of roles among other arguments. */
export async function requireRoles(
  _tx: unknown,
  actor: Actor,
  roles: readonly string[],
  opts: { ownerId?: string } = {},
): Promise<void> {
  if (opts.ownerId === actor.id) return;
  if (!roles.some((r) => actor.roles.includes(r))) throw new Error("forbidden");
}

const STAFF = ["owner", "admin"] as const;

async function ship(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** An array literal among other arguments matches the binding's list. */
export async function shipAsStaff(actor: Actor, orderId: string): Promise<void> {
  await requireRoles(db, actor, ["owner", "admin"], { ownerId: actor.id });
  await ship(orderId);
}

/** Quote style doesn't matter, and a `const` array literal counts as the list. */
export async function shipAsStaffConst(actor: Actor, orderId: string): Promise<void> {
  await requireRoles(db, actor, STAFF);
  await ship(orderId);
}

/** Another list is not the binding. */
export async function shipAsOwnerOnly(actor: Actor, orderId: string): Promise<void> {
  await requireRoles(db, actor, ['owner']);
  await ship(orderId);
}
