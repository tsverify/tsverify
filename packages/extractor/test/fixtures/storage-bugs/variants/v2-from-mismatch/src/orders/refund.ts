import { type Actor, requireRole } from "../auth/guards";
import { stripe } from "../payments/stripe";
import * as store from "../store";

/** BUG: the update's from-states include `shipped`. */
export async function refundOrder(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  const order = await store.loadOrder(id);
  if (order === undefined) throw new Error("no order");
  if (!(await store.setStatusIf(id, ["paid", "shipped"], "refunded"))) throw new Error("changed");
  await stripe.refunds.create({ charge: order.chargeId });
}
