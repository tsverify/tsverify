import { setStatusIf } from "./repo";

/** A conditional save on its own: the status check and the write are one step. */
export async function markPaid(id: string): Promise<void> {
  if (!(await setStatusIf(id, "pending", "paid"))) {
    throw new Error(`order ${id} is not pending`);
  }
}
