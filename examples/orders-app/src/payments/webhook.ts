import { db } from "../db";
import { email } from "../notify/email";

/**
 * The part of Stripe's `payment_intent.succeeded` event the app reads. The HTTP layer verifies
 * the webhook signature before calling the handler.
 */
export interface PaymentSucceededEvent {
  id: string;
  orderId: string;
  chargeId: string;
}

/**
 * Stripe may deliver the same event more than once. Only the delivery that finds the order still
 * awaiting payment marks it paid and sends the receipt; later deliveries are no-ops.
 */
export async function onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
  const paid = await db.transaction(async (tx) => {
    const order = await tx.orders.get(event.orderId);
    if (order.status !== "pending_payment") return undefined;
    order.status = "paid";
    order.chargeId = event.chargeId;
    await tx.orders.save(order);
    return order;
  });
  if (paid === undefined) return;
  await email.send({ to: paid.email, template: "receipt" });
}
