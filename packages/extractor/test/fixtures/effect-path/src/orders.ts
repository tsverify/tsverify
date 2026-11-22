import { audit, email, stripe } from "../../_lib/clients";
import { db } from "../../_lib/db";

/** The catch around the transaction runs only when it failed: its notice is not attributed. */
export async function shipOrder(orderId: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const order = await tx.orders.get(orderId);
      if (order.status !== "paid") throw new Error("not paid");
      order.status = "shipped";
      await tx.orders.save(order);
    });
  } catch (error) {
    await email.send({ to: "support", template: "ship-failed" });
    throw error;
  }
  await email.send({ to: orderId, template: "shipped" });
}

/**
 * The rejection branch never reaches the write, and the catch runs only when the save failed:
 * neither is attributed. The Stripe call before the write is on its path: attributed.
 */
export async function refundOrder(orderId: string): Promise<void> {
  const order = await db.orders.get(orderId);
  if (order.status !== "paid" || order.chargeId === undefined) {
    await audit.log(`refund rejected ${orderId}`);
    throw new Error("not refundable");
  }
  await stripe.refunds.create({ charge: order.chargeId });
  order.status = "refunded";
  try {
    await db.orders.save(order);
  } catch (error) {
    await email.send({ to: "support", template: "refund-save-failed" });
    throw error;
  }
}

/**
 * A flag returned from the transaction, then `if (x === undefined) return`: the helper called
 * after the commit is attributed; the no-op branch's audit inside the callback is not.
 */
export async function payOrder(orderId: string): Promise<void> {
  const paid = await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "pending_payment") {
      await audit.log(`duplicate payment ${orderId}`);
      return undefined;
    }
    order.status = "paid";
    await tx.orders.save(order);
    return order;
  });
  if (paid === undefined) return;
  await sendReceipt(paid.id);
}

async function sendReceipt(id: string): Promise<void> {
  await email.send({ to: id, template: "receipt" });
}

/** The write lives in a helper; the impl's catch around the helper call is not attributed. */
export async function cancelOrder(orderId: string): Promise<void> {
  try {
    await markCancelled(orderId);
  } catch (error) {
    await audit.log(`cancel failed ${orderId}`);
    throw error;
  }
  await email.send({ to: orderId, template: "cancelled" });
}

async function markCancelled(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "pending_payment") throw new Error("not pending");
    order.status = "cancelled";
    await tx.orders.save(order);
  });
}
