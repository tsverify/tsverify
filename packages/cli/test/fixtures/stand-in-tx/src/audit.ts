import type { Tx } from "./db";

/** Writes an audit row in the caller's transaction: not bound, so not replaced by a fake. */
export async function writeAudit(tx: Tx, entry: Record<string, unknown>): Promise<void> {
  await tx.insert("audit", entry);
}
