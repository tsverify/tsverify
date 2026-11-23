import { prisma } from "../../_prisma/db";

/** The update object held in a `const`, used only as the update's `data`: read as if inline. */
export async function refundHeld(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "paid") throw new Error("not paid");
  const data = { status: "refunded" as const, updatedAt: new Date() };
  await prisma.order.update({ where: { id: order.id }, data });
}

/** `data: patch` with the status in `where`: a conditional update. */
export async function shipHeld(orderId: string): Promise<void> {
  const patch = { status: "shipped" as const };
  await prisma.order.updateMany({ where: { id: orderId, status: "paid" }, data: patch });
}

/** A `let` can change before the call: reported, not extracted. */
export async function cancelHeldLet(orderId: string): Promise<void> {
  let data = { status: "cancelled" as const };
  data = { ...data };
  await prisma.order.update({ where: { id: orderId }, data });
}

/** The status set again after the object is built: reported. */
export async function cancelHeldLater(orderId: string, force: boolean): Promise<void> {
  const data: { status: "cancelled" | "draft" } = { status: "cancelled" };
  if (force) data.status = "draft";
  await prisma.order.update({ where: { id: orderId }, data });
}

/** The same object for two updates: reported. */
export async function payHeldTwice(orderId: string, otherId: string): Promise<void> {
  const data = { status: "paid" as const };
  await prisma.order.update({ where: { id: orderId }, data });
  await prisma.order.update({ where: { id: otherId }, data });
}

/** An object with a `status` that never reaches an update (a response body): not a write. */
export function view(): { status: string } {
  const body = { status: "paid" };
  return body;
}
