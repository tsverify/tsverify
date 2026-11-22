import type { Actor } from "../src/auth/actor";
import { prisma } from "../src/db";
import type { Order, OrderStatus } from "../src/generated/prisma/client";
import { emailFake } from "../src/notify/email";
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
  return prisma.order.create({
    data: {
      id: `order-${sequence}`,
      ownerId: alice.id,
      email: "alice@example.com",
      status,
      chargeId: CHARGED.has(status) ? `ch_${sequence}` : null,
    },
  });
}

export async function statusOf(id: string): Promise<OrderStatus> {
  return (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
}

/** Clears the database and the recorded effects. */
export async function resetApp(): Promise<void> {
  await prisma.order.deleteMany();
  stripeFake.reset();
  emailFake.reset();
}
