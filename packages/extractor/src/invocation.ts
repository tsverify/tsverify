/**
 * Data flow from an expression back to the impl's parameters, for `InvocationShape`:
 * `orderId` → `{ param: 1, path: [] }`, `event.orderId` → `{ param: 0, path: ["orderId"] }`,
 * `ctx.actor` → `{ param: 0, path: ["actor"] }`.
 *
 * Followed: property access, `const` aliases (`const id = event.orderId`), object destructuring
 * (of parameters and of `const`s), closures over the frame's parameters, and helper parameters
 * back through the helper's call sites in the impl's reach (all call sites must agree).
 * Not followed: element access, spread arguments, `let` variables, inline-callback parameters.
 */
import type { ArgPath } from "@tsv/ir";
import { ts } from "ts-morph";
import type { Reach } from "./callgraph";
import type { FunctionLike } from "./cfg";

interface LocalPath {
  fn: ts.SignatureDeclaration;
  param: number;
  path: string[];
}

const MAX_STEPS = 16;

function strip(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAwaitExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Property path from a binding element up to its root binding pattern holder. */
function bindingPath(el: ts.BindingElement): { holder: ts.Node; path: string[] } | undefined {
  const path: string[] = [];
  let cur: ts.Node = el;
  while (ts.isBindingElement(cur)) {
    const pattern: ts.Node = cur.parent;
    if (!ts.isObjectBindingPattern(pattern)) return undefined;
    const key = cur.propertyName ?? cur.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return undefined;
    path.unshift(key.text);
    cur = pattern.parent;
  }
  return { holder: cur, path };
}

function fromDeclaration(
  decl: ts.Declaration,
  checker: ts.TypeChecker,
  steps: number,
): LocalPath | undefined {
  if (ts.isParameter(decl)) {
    const fn = decl.parent;
    return { fn, param: fn.parameters.indexOf(decl), path: [] };
  }
  if (ts.isBindingElement(decl)) {
    const b = bindingPath(decl);
    if (!b) return undefined;
    const base = fromDeclaration(b.holder as ts.Declaration, checker, steps + 1);
    return base && { ...base, path: [...base.path, ...b.path] };
  }
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const list = decl.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
    return traceLocal(decl.initializer, checker, steps + 1);
  }
  return undefined;
}

function traceLocal(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  steps = 0,
): LocalPath | undefined {
  if (steps > MAX_STEPS) return undefined;
  const e = strip(expr);
  if (ts.isIdentifier(e)) {
    const sym = checker.getSymbolAtLocation(e);
    const decl = sym?.valueDeclaration;
    return decl ? fromDeclaration(decl, checker, steps) : undefined;
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    const base = traceLocal(e.expression, checker, steps + 1);
    return base && { ...base, path: [...base.path, e.name.text] };
  }
  return undefined;
}

function samePath(a: ArgPath, b: ArgPath): boolean {
  return a.param === b.param && a.path.join(".") === b.path.join(".");
}

/** Where `expr` (inside `reach`) comes from, as an `ArgPath` of the reach root's parameters. */
export function traceToRoot(
  expr: ts.Expression,
  reach: Reach,
  checker: ts.TypeChecker,
  depth = 0,
): ArgPath | undefined {
  const local = traceLocal(expr, checker);
  if (!local || local.param < 0) return undefined;
  if (local.fn === reach.root) return { param: local.param, path: local.path };
  if (depth > MAX_STEPS) return undefined;
  const fn = local.fn as FunctionLike;
  const sites = reach.edges.filter((e) => e.callee === fn);
  if (sites.length === 0) return undefined;
  let agreed: ArgPath | undefined;
  for (const site of sites) {
    const arg = site.call.arguments[local.param];
    if (!arg || ts.isSpreadElement(arg)) return undefined;
    const outer = traceToRoot(arg, reach, checker, depth + 1);
    if (!outer) return undefined;
    const full = { param: outer.param, path: [...outer.path, ...local.path] };
    if (agreed && !samePath(agreed, full)) return undefined;
    agreed = full;
  }
  return agreed;
}
