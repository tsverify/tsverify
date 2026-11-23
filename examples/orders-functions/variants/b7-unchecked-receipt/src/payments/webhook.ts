import { NotFoundError } from "../errors";
import { email } from "../notify/email";
import { getOrder, updateStatusIf } from "../store/orders";

/**
 * The part of Stripe's `payment_intent.succeeded` event the app reads. The HTTP layer verifies
 * the webhook signature before calling the handler.
 */
export interface PaymentSucceededEvent {
  id: string;
  orderId: string;
  chargeId: string;
}

/** BUG: the conditional save's result is ignored; every delivery sends a receipt. */
export async function onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
  const order = await getOrder(event.orderId);
  if (order === undefined) throw new NotFoundError(`order ${event.orderId} not found`);
  await updateStatusIf(event.orderId, "pending_payment", "paid", { chargeId: event.chargeId });
  await email.send({ to: order.email, template: "receipt" });
}
