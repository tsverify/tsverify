/**
 * Read/write separation: a write is atomic when the read that produced the entity, the write
 * itself and its commit all run inside the same atomic scope (the same scope callback, reached
 * through the scope's alias, e.g. `tx`). A read through the root client (`db.orders.get`) inside
 * a transaction callback is *not* in the transaction: it bypasses the scope.
 */
import type { ts } from "ts-morph";
import type { ClientCall, ScopeRef } from "./client-calls";

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    inner.pos >= outer.pos &&
    inner.end <= outer.end
  );
}

/** The scope read, write and commit share, if any. */
export function sharedScope(
  read: ClientCall | undefined,
  write: ts.Node,
  commit: ClientCall | undefined,
): ScopeRef | undefined {
  const scope = read?.scope;
  if (!scope) return undefined;
  if (!contains(scope.callback, write)) return undefined;
  if (commit && commit.scope?.call !== scope.call) return undefined;
  return scope;
}
