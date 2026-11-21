import type { Actor } from "../src/auth/actor";
import { db } from "../src/db";
import { emailFake } from "../src/notify/email";
import type { Order, OrderStatus } from "../src/orders/order";
import { stripeFake } from "../src/payments/stripe";

export const alice: Actor = { id: "alice", roles: [] };
export const bob: Actor = { id: "bob", roles: [] };
export const admin: Actor = { id: "admin-1", roles: ["admin"] };

/** States in which a real order carries a charge. */
const CHARGED: ReadonlySet<OrderStatus> = new Set(["paid", "shipped", "refunded"]);

let sequence = 0;

/** Stores an order of alice's in the given status and returns it. */
export async function seedOrder(status: OrderStatus): Promise<Order> {
  sequence += 1;
  const order: Order = {
    id: `order-${sequence}`,
    ownerId: alice.id,
    email: "alice@example.com",
    status,
    ...(CHARGED.has(status) ? { chargeId: `ch_${sequence}` } : {}),
  };
  await db.orders.save(order);
  return order;
}

export async function statusOf(id: string): Promise<OrderStatus> {
  return (await db.orders.get(id)).status;
}

/** Clears the database and the recorded effects. */
export function resetApp(): void {
  db.reset();
  stripeFake.reset();
  emailFake.reset();
}
