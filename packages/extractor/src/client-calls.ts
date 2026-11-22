/**
 * Classifies call expressions as calls on a bound client (`bindings.clients`): `stripe.refunds.create(…)`
 * → client `stripe`, path `refunds.create`, gate `stripe.refunds.create`.
 *
 * The callee must be a property chain whose root identifier resolves (through imports and
 * re-exports) to the client's exported symbol, or to a parameter the persistence adapter says
 * aliases a client: `db.transaction(async (tx) => tx.orders.get(id))` → `tx.orders.get` is a call on
 * client `db` inside that scope. Not recognized: clients passed as parameters, stored in fields,
 * destructured (`const { orders } = db`), or reached through element access.
 */
import type { AtomicScope } from "@tsverify/ir";
import { ts } from "ts-morph";
import type { PersistenceAdapter } from "./adapters/types";
import { inlineCallbackCall } from "./cfg";
import { symbolOf } from "./resolve";

export interface ScopeRef {
  /** The call that opens the scope, e.g. `db.transaction(…)`. */
  call: ts.CallExpression;
  /** The inline callback that runs inside the scope. */
  callback: ts.ArrowFunction | ts.FunctionExpression;
  kind: AtomicScope["kind"];
  gate: string;
}

export interface ClientCall {
  call: ts.CallExpression;
  client: string;
  path: string;
  gate: string;
  /** Set when the root is a scope alias (`tx`): the scope the call runs in. */
  scope?: ScopeRef;
}

function stripParens(n: ts.Expression): ts.Expression {
  let cur = n;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

export class ClientCalls {
  private readonly memo = new Map<ts.CallExpression, ClientCall | null>();

  constructor(
    private readonly checker: ts.TypeChecker,
    /** Resolved client symbol → client binding name. */
    private readonly clients: ReadonlyMap<ts.Symbol, string>,
    private readonly adapter: PersistenceAdapter,
  ) {}

  classify(call: ts.CallExpression): ClientCall | undefined {
    const cached = this.memo.get(call);
    if (cached !== undefined) return cached ?? undefined;
    this.memo.set(call, null); // cycle guard
    const result = this.compute(call);
    this.memo.set(call, result ?? null);
    return result;
  }

  /** The scope an inline callback runs in, when it is the scope callback of a client call. */
  scopeOfCallback(fn: ts.Node): ScopeRef | undefined {
    const call = inlineCallbackCall(fn);
    if (!call || !ts.isCallExpression(call)) return undefined;
    const outer = this.classify(call);
    if (!outer) return undefined;
    const argIndex = call.arguments.findIndex((a) => stripParens(a) === fn);
    const kind = this.adapter.scopeKind(outer.path, argIndex);
    if (!kind) return undefined;
    return {
      call,
      callback: fn as ts.ArrowFunction | ts.FunctionExpression,
      kind,
      gate: outer.gate,
    };
  }

  /** A client call that opens an atomic scope for one of its inline callbacks (`db.transaction`). */
  isScopeOpener(call: ts.CallExpression): boolean {
    const cc = this.classify(call);
    if (!cc) return false;
    return call.arguments.some((a, i) => {
      const fn = stripParens(a);
      const isFn = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn);
      return isFn && this.adapter.scopeKind(cc.path, i) !== undefined;
    });
  }

  private compute(call: ts.CallExpression): ClientCall | undefined {
    const segments: string[] = [];
    let e: ts.Expression = stripParens(call.expression);
    while (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
      segments.unshift(e.name.text);
      e = stripParens(e.expression);
    }
    if (segments.length === 0 || !ts.isIdentifier(e)) return undefined;
    const root = this.rootOf(e);
    if (!root) return undefined;
    const path = segments.join(".");
    return { call, client: root.client, path, gate: `${root.client}.${path}`, scope: root.scope };
  }

  /** The client an identifier is (a bound client's symbol, or a scope alias such as `tx`). */
  rootOf(id: ts.Identifier): { client: string; scope?: ScopeRef } | undefined {
    const sym = symbolOf(id, this.checker);
    if (!sym) return undefined;
    const direct = this.clients.get(sym);
    if (direct !== undefined) return { client: direct };
    const decl = sym.valueDeclaration;
    if (!decl || !ts.isParameter(decl) || !ts.isIdentifier(decl.name)) return undefined;
    const fn = decl.parent;
    if (fn.parameters.indexOf(decl) !== this.adapter.scopeAliasParam) return undefined;
    const scope = this.scopeOfCallback(fn);
    if (!scope) return undefined;
    const outer = this.classify(scope.call);
    return outer && { client: outer.client, scope };
  }
}
