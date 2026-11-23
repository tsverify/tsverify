import { stripe } from "../payments/stripe";
import { getOrder, setStatusIf } from "./repo";

/** A read, then a conditional save: a concurrent refund finds the order refunded. */
export async function refundOrder(id: string): Promise<void> {
  const order = await getOrder(id);
  if (order === undefined || order.status !== "paid") {
    throw new Error(`order ${id} cannot be refunded`);
  }
  if (!(await setStatusIf(id, ["paid"], "refunded"))) {
    throw new Error(`order ${id} changed while it was being refunded`);
  }
  await stripe.refunds.create({ charge: order.chargeId });
}
