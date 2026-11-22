import { audit, email, stripe } from "../../_lib/clients";
import { db } from "../../_lib/db";

/** Mapped (`stripe.refund`), unmapped (`audit.log`) and repeated (`email.send` ×2) effects. */
export async function refundOrder(orderId: string): Promise<void> {
  const charge = await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid" || order.chargeId === undefined) throw new Error("not refundable");
    order.status = "refunded";
    await tx.orders.save(order);
    return order.chargeId;
  });
  await stripe.refunds.create({ charge });
  await audit.log(`refunded ${orderId}`);
  await email.send({ to: orderId, template: "refund" });
  await email.send({ to: "ops", template: "refund" });
}

/** Two sends on exclusive branches: each is the first occurrence on its path. */
export async function shipOrder(orderId: string, loud: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
  if (loud) await email.send({ to: orderId, template: "shipped-loud" });
  else await email.send({ to: orderId, template: "shipped" });
}
