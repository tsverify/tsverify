import { stripe } from "../payments/stripe";
import { updateStatusIf } from "../store/orders";

/**
 * Cancels an order that is still unpaid. The job queue schedules it 30 minutes after checkout;
 * if the payment arrived in the meantime the conditional save does nothing.
 *
 * @returns whether the order was cancelled
 */
export async function expireOrder(orderId: string): Promise<boolean> {
  const cancelled = await updateStatusIf(orderId, "pending_payment", "cancelled", {});
  if (cancelled === undefined) return false;
  // BUG: an effect the spec does not declare on expire.
  if (cancelled.chargeId !== undefined) await stripe.refunds.create({ charge: cancelled.chargeId });
  return true;
}
