import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/** Ships a paid order (a conditional update). */
export async function shipOrder(orderId: string): Promise<void> {
  await prisma.order.update({ where: { id: orderId, status: "paid" }, data: { status: "shipped" } });
}
