import { db } from "../../_lib/db";
import { sendMail } from "./notify";
import * as notifyEmail from "./notify/email";
import { sendMail as mail, sendSms } from "./notify/email";

async function markShipped(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await tx.orders.get(orderId);
    if (order.status !== "paid") throw new Error("not paid");
    order.status = "shipped";
    await tx.orders.save(order);
  });
}

/** A same-named local function is not the bound export. */
async function sendMailLocally(to: string): Promise<void> {
  await Promise.resolve(to);
}

/** Through the re-exporting barrel (`./notify`). */
export async function shipViaReexport(orderId: string): Promise<void> {
  await markShipped(orderId);
  await sendMail(orderId, "shipped");
}

/** Through an aliased import of the defining module. */
export async function shipViaAlias(orderId: string): Promise<void> {
  await markShipped(orderId);
  await mail(orderId, "shipped");
}

/** Through a namespace import, plus an unbound arrow-function export and a local look-alike. */
export async function shipViaNamespace(orderId: string): Promise<void> {
  await markShipped(orderId);
  await notifyEmail.sendMail(orderId, "shipped");
  await sendSms(orderId);
  await sendMailLocally(orderId);
}
