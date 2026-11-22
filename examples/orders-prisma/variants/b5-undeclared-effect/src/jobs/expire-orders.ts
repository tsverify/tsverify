import { prisma } from "../db";
import { stripe } from "../payments/stripe";

/**
 * Cancels an order that is still unpaid. The job queue schedules it 30 minutes after checkout;
 * if the payment arrived in the meantime the conditional update matches nothing.
 *
 * @returns whether the order was cancelled
 */
export async function expireOrder(orderId: string): Promise<boolean> {
  const { count } = await prisma.order.updateMany({
    where: { id: orderId, status: "pending_payment" },
    data: { status: "cancelled" },
  });
  if (count === 0) return false;
  // Hand back any charge Stripe captured while the order sat unpaid.
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.chargeId !== null) {
    await stripe.refunds.create({ charge: order.chargeId });
  }
  return true;
}
