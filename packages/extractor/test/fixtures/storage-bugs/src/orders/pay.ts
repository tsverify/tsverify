import { setStatusIf } from "../store";

/** A conditional save on its own. */
export async function markPaid(id: string): Promise<void> {
  if (!(await setStatusIf(id, ["pending"], "paid"))) throw new Error("not pending");
}
