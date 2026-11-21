// A helper that is NOT mocked in replay tests. It awaits a few microtasks and one macrotask so
// the tests prove the scheduler tolerates asynchronous noise that it does not control.

import type { Order } from "./db";

async function tick(): Promise<void> {
  await Promise.resolve();
}

export async function auditNote(order: Order, reason: string): Promise<string> {
  await tick();
  await new Promise((resolve) => setImmediate(resolve));
  await tick();
  return `${reason}:${order.id}:${order.amount}`;
}
