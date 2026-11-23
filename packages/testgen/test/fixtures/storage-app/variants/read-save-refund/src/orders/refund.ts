import { stripe } from "../payments/stripe";
import { getOrder, saveOrder } from "./repo";

/** BUG: a plain read + save outside `withTransaction`: two refunds both read "paid". */
export async function refundOrder(id: string): Promise<void> {
  const order = await getOrder(id);
  if (order === undefined || order.status !== "paid") {
    throw new Error(`order ${id} cannot be refunded`);
  }
  order.status = "refunded";
  await saveOrder(order);
  await stripe.refunds.create({ charge: order.chargeId });
}
