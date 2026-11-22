import { stripe } from "../../_lib/clients";
import { $Enums, OrderStatus, Prisma } from "../../_prisma/client";
import { prisma } from "../../_prisma/db";
import { type Actor, requireOwner, requireRole } from "../../_prisma/guards";

/** Conditional updateMany: the database checks `status` with the write. */
export async function refundConditional(ctx: { actor: Actor }, orderId: string): Promise<void> {
  requireRole(ctx.actor, "admin");
  const { count } = await prisma.order.updateMany({
    where: { id: orderId, status: "paid" },
    data: { status: "refunded" },
  });
  if (count === 0) throw new Error("not refundable");
  await stripe.refunds.create({ charge: orderId });
}

/** `update` with the status in `where`, written as a typed enum constant. */
export async function shipConditionalUpdate(orderId: string): Promise<void> {
  await prisma.order.update({
    where: { id: orderId, status: OrderStatus.paid },
    data: { status: $Enums.OrderStatus.shipped },
  });
}

/** `in` and `notIn` filters. */
export async function expireIn(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: { in: ["draft", "pending_payment"] } },
    data: { status: "cancelled" },
  });
}

export async function cancelNotIn(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: { notIn: ["shipped", "refunded", "cancelled"] } },
    data: { status: "cancelled" },
  });
}

export async function refundEquals(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: { equals: "paid" } },
    data: { status: { set: "refunded" } },
  });
}

/** A status condition inside OR: conditional (atomic), from-state not readable. */
export async function refundOr(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, OR: [{ status: "paid" }, { status: "shipped" }] },
    data: { status: "refunded" },
  });
}

/** findUnique, check, await an effect, then update without a condition: the B3 race. */
export async function refundRace(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "paid" || order.chargeId === null) throw new Error("no");
  await stripe.refunds.create({ charge: order.chargeId });
  await prisma.order.update({ where: { id: orderId }, data: { status: "refunded" } });
}

/** Interactive transaction at the default isolation level: still a race. */
export async function refundTxDefault(orderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== "paid") throw new Error("not paid");
    await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
  });
}

/** Serializable, through the generated enum object: atomic. */
export async function refundTxSerializable(orderId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status !== "paid") throw new Error("not paid");
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** Serializable, as a string literal: atomic. */
export async function shipTxSerializable(ctx: { actor: Actor }, orderId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      requireOwner(ctx.actor, order);
      if (order.status !== "paid") throw new Error("not paid");
      await tx.order.update({ where: { id: orderId }, data: { status: "shipped" } });
    },
    { isolationLevel: "Serializable", timeout: 5000 },
  );
}

/** RepeatableRead is not Serializable. */
export async function refundTxRepeatable(orderId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status !== "paid") throw new Error("not paid");
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Serializable, but the read goes through the root client: outside the transaction. */
export async function refundTxRootRead(orderId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status !== "paid") throw new Error("not paid");
      await tx.order.update({ where: { id: orderId }, data: { status: "refunded" } });
    },
    { isolationLevel: "Serializable" },
  );
}

/** The array form cannot check the read before the write. */
export async function refundArray(orderId: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== "paid") throw new Error("not paid");
  await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { status: "refunded" } }),
  ]);
}

/** No read and no status condition: a blind write from any state. */
export async function payBlind(event: { orderId: string; chargeId: string }): Promise<void> {
  await prisma.order.update({
    where: { id: event.orderId },
    data: { status: "paid", chargeId: event.chargeId },
  });
}

/** upsert: the `update` branch is the write; the `create` branch initializes. */
export async function shipUpsert(orderId: string): Promise<void> {
  await prisma.order.upsert({
    where: { id: orderId, status: "paid" },
    create: { id: orderId, ownerId: "o", email: "e", status: "draft" },
    update: { status: "shipped" },
  });
}

/** create initializes a new order: not a transition. */
export async function createDraft(ownerId: string): Promise<void> {
  await prisma.order.create({ data: { ownerId, email: "e", status: "draft" } });
}

/** Another model's status: not an Order write. */
export async function closeLog(id: string): Promise<void> {
  await prisma.refundLog.update({ where: { id }, data: { status: "done" } });
}

function loadOrder(orderId: string) {
  return prisma.order.findUniqueOrThrow({ where: { id: orderId } });
}

/** The read hides in a helper; `where: { id: order.id }` names the reference. */
export async function refundHelperRead(orderId: string): Promise<void> {
  const order = await loadOrder(orderId);
  if (order.status !== "paid") throw new Error("not paid");
  await prisma.order.update({ where: { id: order.id }, data: { status: "refunded" } });
}
