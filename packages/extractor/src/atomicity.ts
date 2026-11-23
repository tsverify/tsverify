/**
 * Atomicity facts.
 *
 * **Scoped** (`assign`): a write is atomic when the read that produced the entity, the write
 * itself and its commit all run inside the same atomic scope (the same scope callback, reached
 * through the scope's alias, e.g. `tx`). A read through the root client (`db.orders.get`) inside
 * a transaction callback is *not* in the transaction: it bypasses the scope.
 *
 * **Synchronous** (`memory`): a write is atomic when no suspension point lies on any control-flow
 * path between the **last re-check** of the entity's state field and the write, or, on a path
 * without a re-check, between the impl's entry and the write (`suspensionBefore`). A re-check is
 * any read `ref.<field>` of the written entity reference (`if (w.status !== "x") return`): after it,
 * the code acts on a state it saw since its last suspension. Suspension points are `await`,
 * `yield` and `for await` steps, plus entering an inline callback that a call defers to a later
 * task or microtask (`.then(cb)`, `setTimeout(cb)`, …). Across frames, only the impl → helper
 * calls that lead to the write count: a helper that is called and not awaited runs synchronously
 * until its own first `await`, so its suspensions do not delay the caller. An `await` inside an
 * inline callback suspends that callback only, so it counts only for writes inside it.
 */
import { type LeadGroup, leadsTo, type Reach } from "./callgraph";
import {
  buildCfg,
  type Cfg,
  ENTRY,
  type FunctionLike,
  inlineCallbackCall,
  isFunctionLike,
  reachable,
} from "./cfg";
import type { ClientCall, ScopeRef } from "./client-calls";
import { valueDeclarationOf } from "./declarations";
import { symbolOf } from "./resolve";
import type * as TS from "./ts-types";
import { ts } from "./typescript";
import type { WriteNode } from "./writes";

function contains(outer: TS.Node, inner: TS.Node): boolean {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    inner.pos >= outer.pos &&
    inner.end <= outer.end
  );
}

/** The scope read, write and commit share, if any. */
export function sharedScope(
  read: ClientCall | undefined,
  write: TS.Node,
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

function calleeName(call: TS.CallExpression | TS.NewExpression): string | undefined {
  let e: TS.Expression = call.expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Suspension points in a frame (its body and inline callbacks), in source order. */
const suspensionsMemo = new WeakMap<FunctionLike, TS.Node[]>();

function suspensionsOf(fn: FunctionLike): TS.Node[] {
  const cached = suspensionsMemo.get(fn);
  if (cached) return cached;
  const out: TS.Node[] = [];
  const visit = (n: TS.Node): void => {
    if ((isFunctionLike(n) && !inlineCallbackCall(n)) || ts.isClassLike(n)) return;
    if (
      ts.isAwaitExpression(n) ||
      ts.isYieldExpression(n) ||
      (ts.isForOfStatement(n) && n.awaitModifier)
    ) {
      out.push(n);
    }
    n.forEachChild(visit);
  };
  if (fn.body) visit(fn.body);
  suspensionsMemo.set(fn, out);
  return out;
}

/** The function an `await` / `yield` suspends: its nearest enclosing function-like. */
function suspendedFunction(n: TS.Node): TS.Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return undefined;
}

function encloses(outer: TS.Node, inner: TS.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

/** The entity reference as seen in one frame: `this` or a symbol, then a property path. */
interface EntityRef {
  root: TS.Symbol | "this";
  path: readonly string[];
}

function stripRef(e: TS.Expression): TS.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return cur;
}

/** `w`, `this`, `ctx.job` → an `EntityRef`; anything else (calls, element access) → undefined. */
function describeRef(e: TS.Expression, checker: TS.Checker): EntityRef | undefined {
  const path: string[] = [];
  let cur = stripRef(e);
  while (ts.isPropertyAccessExpression(cur) && ts.isIdentifier(cur.name)) {
    path.unshift(cur.name.text);
    cur = stripRef(cur.expression);
  }
  if (cur.kind === ts.SyntaxKind.ThisKeyword) return { root: "this", path };
  if (!ts.isIdentifier(cur)) return undefined;
  const sym = symbolOf(cur, checker);
  return sym && { root: sym, path };
}

function sameRef(a: EntityRef, b: EntityRef): boolean {
  return (
    a.root === b.root && a.path.length === b.path.length && a.path.every((p, i) => p === b.path[i])
  );
}

function prefixed(outer: EntityRef | undefined, inner: EntityRef): EntityRef | undefined {
  return outer && { root: outer.root, path: [...outer.path, ...inner.path] };
}

/**
 * The callee's entity reference as the caller sees it at `call`: a parameter becomes the
 * argument, `this` the call's receiver; a symbol declared outside the callee stays itself.
 * Undefined for the callee's locals (the caller cannot re-check them).
 */
function refInCaller(
  ref: EntityRef,
  callee: FunctionLike,
  call: TS.CallExpression,
  checker: TS.Checker,
): EntityRef | undefined {
  if (ref.root === "this") {
    const target = stripRef(call.expression);
    if (!ts.isPropertyAccessExpression(target)) return undefined;
    return prefixed(describeRef(target.expression, checker), ref);
  }
  const decl = valueDeclarationOf(ref.root);
  if (decl && ts.isParameter(decl) && decl.parent === callee) {
    const arg = call.arguments[callee.parameters.indexOf(decl)];
    if (!arg || ts.isSpreadElement(arg)) return undefined;
    return prefixed(describeRef(arg, checker), ref);
  }
  if (decl && contains(callee, decl)) return undefined;
  return ref;
}

/** The function `this` refers to at `n`: its nearest enclosing non-arrow function-like. */
function thisOwner(n: TS.Node): TS.Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p) && !ts.isArrowFunction(p)) return p;
  return undefined;
}

/** The `(ref.field, W)` probe `type-facts.ts` injects before a write: not a read of the code. */
function isProbe(read: TS.PropertyAccessExpression): boolean {
  const comma = read.parent;
  if (
    !ts.isBinaryExpression(comma) ||
    comma.operatorToken.kind !== ts.SyntaxKind.CommaToken ||
    comma.left !== read ||
    !ts.isParenthesizedExpression(comma.parent)
  ) {
    return false;
  }
  let w: TS.Expression = comma.right;
  while (ts.isParenthesizedExpression(w)) w = w.expression;
  return (
    ts.isObjectLiteralExpression(w) ||
    (ts.isBinaryExpression(w) &&
      w.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(w.left) &&
      w.left.name.text === read.name.text)
  );
}

const readCfgMemo = new WeakMap<FunctionLike, Map<string, Cfg>>();

/** The CFG of `fn` with a node for every read of `field`. */
function readCfgOf(fn: FunctionLike, field: string): Cfg {
  let perField = readCfgMemo.get(fn);
  if (!perField) {
    perField = new Map();
    readCfgMemo.set(fn, perField);
  }
  let cfg = perField.get(field);
  if (!cfg) {
    cfg = buildCfg(fn, { readsOf: field });
    perField.set(field, cfg);
  }
  return cfg;
}

/**
 * The first suspension point found on a path from `root`'s entry to `write` (in `writeFrame`)
 * after which the entity's `field` is not read again before the write, or undefined when the
 * write always runs synchronously after its last re-check (or after the impl is entered, on paths
 * without one).
 *
 * Re-checks are reads `ref.<field>` of the write's entity reference, followed up the call path:
 * a helper's parameter is the argument at the call that leads to the write, `this` the call's
 * receiver. When the callers' calls disagree (or the reference is a helper's local), the caller
 * has no re-checks, so the rule falls back to "from the impl's entry" there.
 */
export function suspensionBefore(
  root: Reach,
  writeFrame: FunctionLike,
  write: WriteNode,
  checker: TS.Checker,
): TS.Node | undefined {
  const field = write.field;
  const leads = leadsTo(root, writeFrame, write.expr);
  const cfgFor = (fn: FunctionLike) => readCfgOf(fn, field);

  const refMemo = new Map<FunctionLike, EntityRef | null>();
  const refOf = (fn: FunctionLike, stack: Set<FunctionLike>): EntityRef | undefined => {
    const cached = refMemo.get(fn);
    if (cached !== undefined) return cached ?? undefined;
    if (fn === writeFrame) {
      const own = describeRef(write.ref, checker);
      refMemo.set(fn, own ?? null);
      return own;
    }
    if (stack.has(fn)) return undefined;
    stack.add(fn);
    let ref: EntityRef | undefined;
    let agreed = true;
    for (const g of leads(fn)) {
      if (!g.callee || !ts.isCallExpression(g.node)) continue;
      const inner = refOf(g.callee, stack);
      const here = inner && refInCaller(inner, g.callee, g.node, checker);
      if (!here || (ref && !sameRef(ref, here))) {
        agreed = false;
        break;
      }
      ref = here;
    }
    stack.delete(fn);
    const result = agreed ? ref : undefined;
    refMemo.set(fn, result ?? null);
    return result;
  };

  const checksMemo = new Map<FunctionLike, Set<number>>();
  const checksOf = (fn: FunctionLike): Set<number> => {
    const cached = checksMemo.get(fn);
    if (cached) return cached;
    const out = new Set<number>();
    const ref = refOf(fn, new Set());
    if (ref) {
      const cfg = cfgFor(fn);
      cfg.nodes.forEach((n, id) => {
        if (!n || !ts.isPropertyAccessExpression(n) || isProbe(n)) return;
        const read = describeRef(n.expression, checker);
        if (!read || !sameRef(read, ref)) return;
        if (ref.root === "this" && thisOwner(n) !== fn) return;
        out.add(id);
      });
    }
    checksMemo.set(fn, out);
    return out;
  };

  // A path from `fn`'s entry to the write (through its leads) that passes no re-check.
  const clearMemo = new Map<FunctionLike, boolean>();
  const clearFromEntry = (fn: FunctionLike, stack: Set<FunctionLike>): boolean => {
    const cached = clearMemo.get(fn);
    if (cached !== undefined) return cached;
    if (stack.has(fn)) return false;
    stack.add(fn);
    const result = unchecked(fn, [ENTRY], stack);
    stack.delete(fn);
    clearMemo.set(fn, result);
    return result;
  };
  // Some lead of `fn` is reachable from `starts` without a re-check, and so is the write below it.
  const unchecked = (
    fn: FunctionLike,
    starts: readonly number[],
    stack: Set<FunctionLike>,
    only?: LeadGroup,
  ): boolean => {
    const cfg = cfgFor(fn);
    const seen = reachable(cfg, starts, checksOf(fn));
    return (only ? [only] : leads(fn)).some(
      (g) =>
        cfg.idsOf(g.node).some((id) => seen[id] === 1) &&
        (!g.callee || clearFromEntry(g.callee, stack)),
    );
  };

  /** A suspension point in `fn` on a path to lead `g` with no re-check after it. */
  const localSuspension = (fn: FunctionLike, g: LeadGroup): TS.Node | undefined => {
    const cfg = cfgFor(fn);
    for (let p = g.node.parent; p && p !== fn; p = p.parent) {
      if (!isFunctionLike(p)) continue;
      const call = inlineCallbackCall(p);
      const name = call && calleeName(call);
      if (name === undefined || !DEFERRING.has(name)) continue;
      if (unchecked(fn, cfg.idsOf(p), new Set(), g)) return p;
    }
    let fromEntry: Uint8Array | undefined;
    for (const s of suspensionsOf(fn)) {
      const suspended = suspendedFunction(s);
      if (!suspended || !encloses(suspended, g.node)) continue;
      fromEntry ??= reachable(cfg, [ENTRY]);
      const ids = cfg.idsOf(s);
      if (!ids.some((id) => fromEntry?.[id] === 1)) continue;
      if (unchecked(fn, ids, new Set(), g)) return s;
    }
    return undefined;
  };

  const visited = new Set<FunctionLike>();
  const visit = (fn: FunctionLike): TS.Node | undefined => {
    if (visited.has(fn)) return undefined;
    visited.add(fn);
    for (const g of leads(fn)) {
      const found = localSuspension(fn, g) ?? (g.callee && visit(g.callee));
      if (found) return found;
    }
    return undefined;
  };
  return visit(root.root);
}
