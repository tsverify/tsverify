import type { stripe } from "../../_lib/clients";
import { Prisma, type PrismaClient } from "../../_prisma/client";

/** A NestJS-style service: the Prisma client and the payment SDK are injected. */
export class OrderService {
  private readonly db: PrismaClient;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly payments: typeof stripe,
    db: PrismaClient,
  ) {
    this.db = db;
  }

  /** Conditional update through a constructor parameter property. */
  async ship(orderId: string): Promise<void> {
    await this.prisma.order.update({
      where: { id: orderId, status: "paid" },
      data: { status: "shipped" },
    });
  }

  /** Read, effect, then an unconditional update: the race, seen through injected clients. */
  async refund(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "paid" || order.chargeId === null) throw new Error("no");
    await this.payments.refunds.create({ charge: order.chargeId });
    await this.prisma.order.update({ where: { id: orderId }, data: { status: "refunded" } });
  }

  /** A Serializable interactive transaction opened on a field assigned in the constructor. */
  async cancel(orderId: string): Promise<void> {
    await this.db.$transaction(
      async (tx) => {
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (order.status !== "draft") throw new Error("not a draft");
        await tx.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
