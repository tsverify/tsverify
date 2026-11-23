import { NotFoundError } from "../errors";
import { email } from "../notify/email";
import { getOrder, saveOrder } from "../store/orders";
import { withTransaction } from "../store/transaction";

/**
 * The part of Stripe's `payment_intent.succeeded` event the app reads. The HTTP layer verifies
 * the webhook signature before calling the handler.
 */
export interface PaymentSucceededEvent {
  id: string;
  orderId: string;
  chargeId: string;
}

/** BUG: no status check, so every delivery marks the order paid and sends a receipt. */
export async function onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
  const paid = await withTransaction(async () => {
    const order = await getOrder(event.orderId);
    if (order === undefined) throw new NotFoundError(`order ${event.orderId} not found`);
    order.status = "paid";
    order.chargeId = event.chargeId;
    await saveOrder(order);
    return order;
  });
  await email.send({ to: paid.email, template: "receipt" });
}
