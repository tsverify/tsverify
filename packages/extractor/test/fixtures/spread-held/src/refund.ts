import { db } from "../../_lib/db";

/** The spread object held in a `const` that only the save takes: read as if passed inline. */
export async function refundOrder(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    const next = { ...order, status: "refunded" as const };
    await tx.orders.save(next);
  });
}

/** Saved twice: reported, not extracted. */
export async function shipTwice(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  const next = { ...order, status: "shipped" as const };
  await db.orders.save(next);
  await db.orders.save(next);
}

/** A copy of the entity whose status is set afterwards, then saved. */
export async function cancelFilled(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "pending_payment") throw new Error("not pending");
    const next = { ...order };
    next.status = "cancelled";
    await tx.orders.save(next);
  });
}

/** An empty patch filled afterwards, merged into the entity by the save. */
export async function cancelPatch(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "pending_payment") throw new Error("not pending");
    const patch: Partial<typeof order> = {};
    patch.status = "cancelled";
    await tx.orders.save({ ...order, ...patch });
  });
}
