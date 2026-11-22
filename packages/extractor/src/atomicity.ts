/**
 * Atomicity facts.
 *
 * **Scoped** (`assign`): a write is atomic when the read that produced the entity, the write
 * itself and its commit all run inside the same atomic scope (the same scope callback, reached
 * through the scope's alias, e.g. `tx`). A read through the root client (`db.orders.get`) inside
 * a transaction callback is *not* in the transaction: it bypasses the scope.
 *
 * **Synchronous** (`memory`): a write is atomic when no suspension point lies on any control-flow
 * path from the impl's entry to the write (`suspensionBefore`). Suspension points are `await`,
 * `yield` and `for await` steps, plus entering an inline callback that a call defers to a later
 * task or microtask (`.then(cb)`, `setTimeout(cb)`, …). Across frames, only the impl → helper
 * calls that lead to the write count: a helper that is called and not awaited runs synchronously
 * until its own first `await`, so its suspensions do not delay the caller. An `await` inside an
 * inline callback suspends that callback only, so it counts only for writes inside it.
 */
import { ts } from "ts-morph";
import type { Reach } from "./callgraph";
import { ENTRY, type FunctionLike, inlineCallbackCall, isFunctionLike, reachable } from "./cfg";
import type { ClientCall, ScopeRef } from "./client-calls";
import { cfgOf } from "./dominance";

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

/** Callee names that run their callback argument later, never during the call. */
const DEFERRING = new Set([
  "then",
  "catch",
  "finally",
  "queueMicrotask",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "nextTick",
]);

function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  let e: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Suspension points in a frame (its body and inline callbacks), in source order. */
const suspensionsMemo = new WeakMap<FunctionLike, ts.Node[]>();

function suspensionsOf(fn: FunctionLike): ts.Node[] {
  const cached = suspensionsMemo.get(fn);
  if (cached) return cached;
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if ((isFunctionLike(n) && !inlineCallbackCall(n)) || ts.isClassLike(n)) return;
    if (
      ts.isAwaitExpression(n) ||
      ts.isYieldExpression(n) ||
      (ts.isForOfStatement(n) && n.awaitModifier)
    ) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  suspensionsMemo.set(fn, out);
  return out;
}

/** The function an `await` / `yield` suspends: its nearest enclosing function-like. */
function suspendedFunction(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return undefined;
}

function encloses(outer: ts.Node, inner: ts.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

/** A suspension point in `fn` on a path from its entry to `target` (a node of `fn`'s frame). */
function localSuspension(fn: FunctionLike, target: ts.Node): ts.Node | undefined {
  for (let p = target.parent; p && p !== fn; p = p.parent) {
    if (!isFunctionLike(p)) continue;
    const call = inlineCallbackCall(p);
    const name = call && calleeName(call);
    if (name !== undefined && DEFERRING.has(name)) return p;
  }
  const cfg = cfgOf(fn);
  const targets = cfg.idsOf(target);
  let fromEntry: Uint8Array | undefined;
  for (const s of suspensionsOf(fn)) {
    const suspended = suspendedFunction(s);
    if (!suspended || !encloses(suspended, target)) continue;
    fromEntry ??= reachable(cfg, [ENTRY]);
    const ids = cfg.idsOf(s);
    if (!ids.some((id) => fromEntry?.[id] === 1)) continue;
    const after = reachable(cfg, ids);
    if (targets.some((t) => after[t] === 1)) return s;
  }
  return undefined;
}

/**
 * The first suspension point found on a path from `root`'s entry to `write` (in `writeFrame`),
 * or undefined when the write always runs synchronously after the impl is entered.
 */
export function suspensionBefore(
  root: Reach,
  writeFrame: FunctionLike,
  write: ts.Node,
): ts.Node | undefined {
  const leadsMemo = new Map<FunctionLike, { node: ts.Node; callee?: FunctionLike }[]>();
  const leads = (fn: FunctionLike, stack: Set<FunctionLike>) => {
    const cached = leadsMemo.get(fn);
    if (cached) return cached;
    if (stack.has(fn)) return [];
    stack.add(fn);
    const groups: { node: ts.Node; callee?: FunctionLike }[] =
      fn === writeFrame ? [{ node: write }] : [];
    for (const e of root.edges) {
      if (e.caller !== fn) continue;
      if (leads(e.callee, stack).length > 0) groups.push({ node: e.call, callee: e.callee });
    }
    stack.delete(fn);
    leadsMemo.set(fn, groups);
    return groups;
  };
  const visited = new Set<FunctionLike>();
  const visit = (fn: FunctionLike): ts.Node | undefined => {
    if (visited.has(fn)) return undefined;
    visited.add(fn);
    for (const g of leads(fn, new Set())) {
      const found = localSuspension(fn, g.node) ?? (g.callee && visit(g.callee));
      if (found) return found;
    }
    return undefined;
  };
  return visit(root.root);
}
