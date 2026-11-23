import type { Order } from "./repo";

/** An older data layer the spec does not name. */
export async function patchOrderRow(_id: string, _fields: Partial<Order>): Promise<void> {}
