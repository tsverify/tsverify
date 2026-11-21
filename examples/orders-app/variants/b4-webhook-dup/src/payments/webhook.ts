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

/** Marks the order paid and sends the receipt. */
export async function onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
  const paid = await db.transaction(async (tx) => {
    const order = await tx.orders.get(event.orderId);
    order.status = "paid";
    order.chargeId = event.chargeId;
    await tx.orders.save(order);
    return order;
  });
  await email.send({ to: paid.email, template: "receipt" });
}
