import { withTransaction } from "../db";
import { getOrder, saveOrder } from "./repo";

/** A read and a save inside the atomic function. */
export async function shipOrder(id: string): Promise<void> {
  await withTransaction(async () => {
    const order = await getOrder(id);
    if (order === undefined || order.status !== "paid") {
      throw new Error(`order ${id} cannot be shipped`);
    }
    order.status = "shipped";
    await saveOrder(order);
  });
}
