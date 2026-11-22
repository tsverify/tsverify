/**
 * `assign` persistence: a repository-style client whose collections are read and saved as whole
 * objects, with the state changed by plain assignment or by a spread passed to the commit.
 *
 * ```ts
 * await db.transaction(async (tx) => {           // scope: <client>.transaction(callback), param 0 = alias
 *   const order = await tx.orders.get(orderId);  // read: the client call initializing the reference
 *   order.status = "shipped";                    // write
 *   await tx.orders.save(order);                 // commit: next client call taking the reference
 * });
 * await db.orders.save({ ...order, status: "refunded" }); // spread write: the call is the commit
 * ```
 *
 * **Read through a helper.** When the reference's initializer is a call to a project function
 * (`const order = await loadOrder(tx, id)`), the read is looked up in that function's return
 * expressions (`return tx.orders.get(id)`, `return await …`, or a returned local `const` whose
 * initializer is such a call), through further helpers up to `MAX_DEPTH` levels. A helper's
 * parameters stand for the call's arguments, so `tx.orders.get` inside `loadOrder(tx, id)` is a
 * call on the transaction alias and `repo.get` inside `fromRepo(tx.orders, id)` is
 * `tx.orders.get`. The read site is the client call inside the helper; its scope is the
 * argument's, so a helper called with `tx` inside the transaction callback reads in the scope,
 * and one called with the root client (`loadOrder(db, id)`) does not.
 *
 * Storage: the read's client, its path minus the method (`orders.get` → `orders`), and key `id`
 * when the entity type has an `id` property.
 */
import { ts } from "ts-morph";
import { sharedScope } from "../atomicity";
import { MAX_DEPTH } from "../callgraph";
import { type FunctionLike, isFunctionLike } from "../cfg";
import type { ClientCall, ScopeRef } from "../client-calls";
import { symbolOf } from "../resolve";
import { declaredTypeOfRef } from "../type-facts";
import { parentSkippingWrappers, referenceText, unwrapArgument } from "../writes";
import type { AdapterInput, PersistenceAdapter, PersistenceFacts } from "./types";

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

function scopeKind(path: string, argIndex: number): ScopeRef["kind"] | undefined {
  return path === "transaction" && argIndex === 0 ? "transaction" : undefined;
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return (
    outer.getSourceFile() === inner.getSourceFile() &&
    inner.pos >= outer.pos &&
    inner.end <= outer.end
  );
}

/** A helper being followed: `fn`, called at `call`, so its parameters are that call's arguments. */
interface HelperFrame {
  fn: FunctionLike;
  call: ts.CallExpression;
  outer?: HelperFrame;
}

/** The client a property chain is rooted at, plus the chain; helper parameters are substituted. */
function chainRoot(
  e: ts.Expression,
  helper: HelperFrame | undefined,
  input: AdapterInput,
): { client: string; scope?: ScopeRef; segments: string[] } | undefined {
  const segments: string[] = [];
  let cur = strip(e);
  while (ts.isPropertyAccessExpression(cur) && ts.isIdentifier(cur.name)) {
    segments.unshift(cur.name.text);
    cur = strip(cur.expression);
  }
  if (!ts.isIdentifier(cur)) return undefined;
  const decl = helper && symbolOf(cur, input.checker)?.valueDeclaration;
  if (helper && decl && ts.isParameter(decl) && decl.parent === helper.fn) {
    const arg = helper.call.arguments[helper.fn.parameters.indexOf(decl)];
    if (!arg || ts.isSpreadElement(arg)) return undefined;
    const inner = chainRoot(arg, helper.outer, input);
    return inner && { ...inner, segments: [...inner.segments, ...segments] };
  }
  const root = input.calls.rootOf(cur);
  return root && { ...root, segments };
}

/** Expressions `fn` returns (its expression body, or its `return`s outside nested functions). */
function returnedExpressions(fn: FunctionLike): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

/** A returned local variable of `fn`, replaced by its initializer. */
function throughLocal(e: ts.Expression, fn: FunctionLike, checker: ts.TypeChecker): ts.Expression {
  if (!ts.isIdentifier(e)) return e;
  const decl = symbolOf(e, checker)?.valueDeclaration;
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer && contains(fn, decl)) {
    return strip(decl.initializer);
  }
  return e;
}

/** The client read `call` performs: itself, or the read a helper it calls returns. */
function readThrough(
  call: ts.CallExpression,
  helper: HelperFrame | undefined,
  depth: number,
  input: AdapterInput,
): ClientCall | undefined {
  const root = chainRoot(call.expression, helper, input);
  if (root && root.segments.length > 0) {
    const path = root.segments.join(".");
    const opensScope = call.arguments.some((a, i) => {
      const fn = strip(a);
      return (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && scopeKind(path, i);
    });
    if (opensScope) return undefined;
    const gate = `${root.client}.${path}`;
    return { call, client: root.client, path, gate, ...(root.scope ? { scope: root.scope } : {}) };
  }
  if (depth >= MAX_DEPTH) return undefined;
  const callee = input.callees.of(call);
  if (!callee) return undefined;
  const frame: HelperFrame = { fn: callee, call, ...(helper ? { outer: helper } : {}) };
  for (const r of returnedExpressions(callee)) {
    const e = throughLocal(strip(r), callee, input.checker);
    if (!ts.isCallExpression(e)) continue;
    const found = readThrough(e, frame, depth + 1, input);
    if (found) return found;
  }
  return undefined;
}

/** The client read the reference was initialized with, directly or through helpers. */
export function findRead(
  input: AdapterInput,
  refSym: ts.Symbol | undefined,
): ClientCall | undefined {
  const decl = refSym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const init = strip(decl.initializer);
  if (!ts.isCallExpression(init)) return undefined;
  return input.calls.classify(init) ?? readThrough(init, undefined, 0, input);
}

function findCommit(
  input: AdapterInput,
  refSym: ts.Symbol | undefined,
  read: ClientCall | undefined,
): ClientCall | undefined {
  const { write, calls, checker } = input;
  if (write.kind === "spread") {
    const parent = parentSkippingWrappers(write.expr);
    return parent && ts.isCallExpression(parent) ? calls.classify(parent) : undefined;
  }
  if (!refSym) return undefined;
  const after = write.expr.getEnd();
  for (const call of input.frameCalls) {
    if (call.getStart() < after) continue;
    const cc = calls.classify(call);
    if (!cc || (read && cc.client !== read.client)) continue;
    const passesRef = call.arguments.some((a) => {
      const arg = strip(unwrapArgument(a) as ts.Expression);
      return ts.isIdentifier(arg) && symbolOf(arg, checker) === refSym;
    });
    if (passesRef) return cc;
  }
  return undefined;
}

export const assignAdapter: PersistenceAdapter = {
  kind: "assign",
  writeKinds: new Set(["assign", "spread"]),
  scopeAliasParam: 0,

  scopeKind,

  analyzeWrite(input): PersistenceFacts {
    const { write, checker } = input;
    const problems: string[] = [];
    const ref = strip(write.ref);
    const refSym = ts.isIdentifier(ref) ? symbolOf(ref, checker) : undefined;
    const refText = referenceText(write.ref) ?? write.ref.getText();
    const read = findRead(input, refSym);
    if (!read) {
      problems.push(
        `no read of \`${refText}\` through a bound client was found before this write, so ` +
          "atomicity cannot be decided (reported as not atomic)",
      );
    }
    const commit = findCommit(input, refSym, read);
    const scope = sharedScope(read, write.expr, commit);
    const source = read ?? commit;
    let storage: PersistenceFacts["storage"];
    if (source) {
      const segments = source.path.split(".");
      const collection = segments.slice(0, -1).join(".");
      const refType = declaredTypeOfRef(write.ref, checker);
      const hasId = checker.getPropertyOfType(checker.getApparentType(refType), "id") !== undefined;
      if (collection !== "" && hasId) storage = { client: source.client, collection, key: "id" };
    }
    return { read, commit, scope, atomic: scope !== undefined, storage, problems };
  },
};
