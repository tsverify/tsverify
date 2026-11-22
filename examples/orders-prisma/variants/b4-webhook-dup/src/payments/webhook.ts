import { prisma } from "../db";
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
 * Stripe may deliver the same event more than once. Only the delivery whose conditional update
 * still finds the order awaiting payment marks it paid and sends the receipt; later deliveries
 * match no row and do nothing.
 */
export async function onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
  const { count } = await prisma.order.updateMany({
    where: { id: event.orderId },
    data: { status: "paid", chargeId: event.chargeId },
  });
  if (count === 0) return;
  const order = await prisma.order.findUniqueOrThrow({ where: { id: event.orderId } });
  await email.send({ to: order.email, template: "receipt" });
}
