import { type Actor, requireRole } from "../auth/guards";
import { stripe } from "../payments/stripe";
import * as store from "../store";

/** A read, then a conditional save; the refund only after it succeeded. */
export async function refundOrder(actor: Actor, id: string): Promise<void> {
  requireRole(actor, "admin");
  const order = await store.loadOrder(id);
  if (order === undefined || order.status !== "paid") throw new Error("not paid");
  if (!(await store.setStatusIf(id, ["paid"], "refunded"))) throw new Error("changed");
  await stripe.refunds.create({ charge: order.chargeId });
}
