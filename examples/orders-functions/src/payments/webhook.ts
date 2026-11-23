import { email } from "../notify/email";
import { updateStatusIf } from "../store/orders";

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
 * Stripe may deliver the same event more than once. The conditional save marks the order paid
 * only while it still awaits payment; later deliveries get `undefined` and send nothing.
 */
export async function onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
  const paid = await updateStatusIf(event.orderId, "pending_payment", "paid", {
    chargeId: event.chargeId,
  });
  if (paid === undefined) return;
  await email.send({ to: paid.email, template: "receipt" });
}
