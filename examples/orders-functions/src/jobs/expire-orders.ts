import { updateStatusIf } from "../store/orders";

/**
 * Cancels an order that is still unpaid. The job queue schedules it 30 minutes after checkout;
 * if the payment arrived in the meantime the conditional save does nothing.
 *
 * @returns whether the order was cancelled
 */
export async function expireOrder(orderId: string): Promise<boolean> {
  const cancelled = await updateStatusIf(orderId, "pending_payment", "cancelled", {});
  return cancelled !== undefined;
}
