import { type Actor, requireRole } from "../auth/guards";
import { stripe } from "../payments/stripe";
import * as store from "../store";

/** BUG: Stripe refunds even when the order changed in between. */
export async function refundOrder(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  const order = await store.loadOrder(id);
  if (order === undefined || order.status !== "paid") throw new Error("not paid");
  const saved = await store.setStatusIf(id, ["paid"], "refunded");
  await stripe.refunds.create({ charge: order.chargeId });
  if (!saved) throw new Error("changed");
}
