import { email } from "../../_lib/clients";
import { db } from "../../_lib/db";

export interface CancelEvent {
  id: string;
  orderId: string;
}

/** The impl only delegates; the write and the effect live in a non-exported helper. */
export async function onCancelRequested(event: CancelEvent): Promise<void> {
  const cancelled = await markCancelled(event.orderId);
  if (cancelled) await notify(event.orderId);
}

async function markCancelled(orderId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "pending_payment") return false;
    order.status = "cancelled";
    await tx.orders.save(order);
    return true;
  });
}

async function notify(orderId: string): Promise<void> {
  await email.send({ to: orderId, template: "cancelled" });
}
