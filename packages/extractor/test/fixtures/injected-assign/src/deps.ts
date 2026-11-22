import type { audit, email } from "../../_lib/clients";
import type { db } from "../../_lib/db";
import type { Database } from "../../_lib/db";

export interface Deps {
  db: typeof db;
  email: typeof email;
}

/** Looks like the audit client but is its own type: not a bound client. */
export interface Logger {
  log(line: string): Promise<void>;
}

/** Clients through a `deps` parameter. */
export async function shipWithDeps(deps: Deps, orderId: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
  await deps.email.send({ to: orderId, template: "shipped" });
}

/** Clients through a destructured context typed as the client's interface. */
export async function refundWithContext(
  { db, auditLog }: { db: Database; auditLog: typeof audit },
  logger: Logger,
  orderId: string,
): Promise<void> {
  const order = await db.orders.get(orderId);
  if (order.status !== "paid") throw new Error("not paid");
  order.status = "refunded";
  await db.orders.save(order);
  await auditLog.log(`refunded ${orderId}`);
  await logger.log(`refunded ${orderId}`);
}
