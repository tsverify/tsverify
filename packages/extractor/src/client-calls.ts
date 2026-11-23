/**
 * Classifies call expressions as calls on a bound client (`bindings.clients`): `stripe.refunds.create(…)`
 * → client `stripe`, path `refunds.create`, gate `stripe.refunds.create`.
 *
 * The callee is a property chain `root.a.b…` (or a bare `root(…)`) whose root is the client when:
 * - **by symbol**: the root identifier resolves (through imports, aliased imports and re-exports)
 *   to the client's exported symbol, or a prefix `ns.x` does (a namespace import);
 * - **scope alias**: the root is a parameter the persistence adapter says aliases a client:
 *   `db.transaction(async (tx) => tx.orders.get(id))` → `tx.orders.get` is a call on `db` inside
 *   that scope;
 * - **by type** (injected clients): the root identifier, or a prefix `this.x` / `deps.x`, is a
 *   parameter, class field (including a constructor parameter property), property signature,
 *   destructured binding or variable whose declared type is the bound export's type (`typeof db`,
 *   or the class or interface the export is typed as): `constructor(private prisma: PrismaClient)`
 *   → `this.prisma.order.update(…)`; `(deps: { db: typeof db }) => deps.db.orders.get(id)`. Types
 *   compare by identity, so an object of another type never matches; a type shared by several
 *   clients, or one that is not an object or function type (`any`, primitives, `{}`), matches
 *   none.
 *
 * A call to a named storage function (`bindings.storage`) is classified first, by the callee's
 * resolved symbol (`storage`, from the `functions` adapter): client `storage`, path = the bound
 * symbol, gate `storage.<symbol>`.
 *
 * A bare call on a client that is an exported function (`sendMail(…)`, bound as
 * `email: { export: sendMail }`) has path `""` and gate `email`. Not recognized: element access
 * (`db["orders"]`), a destructured member (`const { orders } = db`), and a call's result as root.
 */
import type { AtomicScope } from "@tsverify/ir";
import type { PersistenceAdapter } from "./adapters/types";
import { inlineCallbackCall } from "./cfg";
import { valueDeclarationOf } from "./declarations";
import { symbolOf } from "./resolve";
import type * as TS from "./ts-types";
import { ts } from "./typescript";

export interface ScopeRef {
  /** The call that opens the scope, e.g. `db.transaction(…)`. */
  call: TS.CallExpression;
  /** The inline callback that runs inside the scope. */
  callback: TS.ArrowFunction | TS.FunctionExpression;
  kind: AtomicScope["kind"];
  gate: string;
}

export interface ClientCall {
  call: TS.CallExpression;
  client: string;
  path: string;
  gate: string;
  /** Set when the root is a scope alias (`tx`): the scope the call runs in. */
  scope?: ScopeRef;
}

export interface ChainRoot {
  client: string;
  /** Set when the root is a scope alias (`tx`). */
  scope?: ScopeRef;
  /** The property names below the client, e.g. `["orders", "get"]`. */
  segments: string[];
}

function stripParens(n: TS.Expression): TS.Expression {
  let cur = n;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function stripExpr(n: TS.Expression): TS.Expression {
  let cur = n;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Declarations whose declared type identifies an injected client. */
function isTypedHolder(decl: TS.Node): boolean {
  return (
    ts.isParameter(decl) ||
    ts.isPropertyDeclaration(decl) ||
    ts.isPropertySignature(decl) ||
    ts.isBindingElement(decl) ||
    ts.isVariableDeclaration(decl)
  );
}

export class ClientCalls {
  private readonly memo = new Map<TS.CallExpression, ClientCall | null>();
  /** Client export type → the client names of that type (built on first use). */
  private clientTypes: Map<TS.Type, string[]> | undefined;

  constructor(
    private readonly checker: TS.Checker,
    /** Resolved client symbol → client binding name. */
    private readonly clients: ReadonlyMap<TS.Symbol, string>,
    private readonly adapter: PersistenceAdapter,
    /** Named storage functions: a call to one, as a `storage.<symbol>` client call. */
    private readonly storage?: (call: TS.CallExpression) => ClientCall | undefined,
  ) {}

  classify(call: TS.CallExpression): ClientCall | undefined {
    const cached = this.memo.get(call);
    if (cached !== undefined) return cached ?? undefined;
    this.memo.set(call, null); // cycle guard
    const result = this.compute(call);
    this.memo.set(call, result ?? null);
    return result;
  }

  /** The scope an inline callback runs in, when it is the scope callback of a client call. */
  scopeOfCallback(fn: TS.Node): ScopeRef | undefined {
    const call = inlineCallbackCall(fn);
    if (!call || !ts.isCallExpression(call)) return undefined;
    const outer = this.classify(call);
    if (!outer) return undefined;
    const argIndex = call.arguments.findIndex((a) => stripParens(a) === fn);
    const kind = this.adapter.scopeKind(outer.path, argIndex);
    if (!kind) return undefined;
    return {
      call,
      callback: fn as TS.ArrowFunction | TS.FunctionExpression,
      kind,
      gate: outer.gate,
    };
  }

  /** A client call that opens an atomic scope for one of its inline callbacks (`db.transaction`). */
  isScopeOpener(call: TS.CallExpression): boolean {
    const cc = this.classify(call);
    if (!cc) return false;
    return call.arguments.some((a, i) => {
      const fn = stripParens(a);
      const isFn = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn);
      return isFn && this.adapter.scopeKind(cc.path, i) !== undefined;
    });
  }

  private compute(call: TS.CallExpression): ClientCall | undefined {
    const stored = this.storage?.(call);
    if (stored) return stored;
    const root = this.chainRoot(call.expression);
    // A scope alias is a stand-in for the client object; calling it is not a client call.
    if (!root || (root.scope && root.segments.length === 0)) return undefined;
    const path = root.segments.join(".");
    const gate = path === "" ? root.client : `${root.client}.${path}`;
    return { call, client: root.client, path, gate, ...(root.scope ? { scope: root.scope } : {}) };
  }

  /** The client a property chain (`db.orders.get`, `this.prisma.order`) is rooted at. */
  chainRoot(expr: TS.Expression): ChainRoot | undefined {
    const accesses: TS.PropertyAccessExpression[] = [];
    let e = stripExpr(expr);
    while (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
      accesses.unshift(e);
      e = stripExpr(e.expression);
    }
    const names = accesses.map((a) => a.name.text);
    if (ts.isIdentifier(e)) {
      const root = this.rootOf(e);
      if (root) return { ...root, segments: names };
    } else if (e.kind !== ts.SyntaxKind.ThisKeyword) {
      return undefined;
    }
    for (let i = 0; i < accesses.length; i++) {
      const sym = symbolOf(accesses[i] as TS.PropertyAccessExpression, this.checker);
      const client = sym && (this.clients.get(sym) ?? this.byType(sym));
      if (client !== undefined) return { client, segments: names.slice(i + 1) };
    }
    return undefined;
  }

  /** The client an identifier is: a bound client's symbol, a scope alias (`tx`), or by type. */
  rootOf(id: TS.Identifier): { client: string; scope?: ScopeRef } | undefined {
    const sym = symbolOf(id, this.checker);
    if (!sym) return undefined;
    const direct = this.clients.get(sym);
    if (direct !== undefined) return { client: direct };
    const alias = this.scopeAlias(sym);
    if (alias) return alias;
    const typed = this.byType(sym);
    return typed === undefined ? undefined : { client: typed };
  }

  private scopeAlias(sym: TS.Symbol): { client: string; scope: ScopeRef } | undefined {
    const decl = valueDeclarationOf(sym);
    if (!decl || !ts.isParameter(decl) || !ts.isIdentifier(decl.name)) return undefined;
    const fn = decl.parent as TS.SignatureDeclaration;
    if (fn.parameters.indexOf(decl) !== this.adapter.scopeAliasParam) return undefined;
    const scope = this.scopeOfCallback(fn);
    if (!scope) return undefined;
    const outer = this.classify(scope.call);
    return outer && { client: outer.client, scope };
  }

  /** The one client whose export type is `sym`'s declared type (an injected client). */
  private byType(sym: TS.Symbol): string | undefined {
    const decl = valueDeclarationOf(sym);
    if (!decl || !isTypedHolder(decl)) return undefined;
    const declared = this.checker.getTypeOfSymbol(sym);
    const type = declared && this.checker.getNonNullableType(declared);
    const names = type && this.typeIndex().get(type);
    return names?.length === 1 ? names[0] : undefined;
  }

  private typeIndex(): Map<TS.Type, string[]> {
    if (this.clientTypes) return this.clientTypes;
    const index = new Map<TS.Type, string[]>();
    for (const [sym, name] of this.clients) {
      const type = this.checker.getTypeOfSymbol(sym);
      if (!type || !this.identifiesClient(type)) continue;
      const names = index.get(type) ?? [];
      if (!names.includes(name)) names.push(name);
      index.set(type, names);
    }
    this.clientTypes = index;
    return index;
  }

  /** An object or function type with members: `any`, primitives and `{}` identify nothing. */
  private identifiesClient(type: TS.Type): boolean {
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return false;
    return (
      this.checker.getPropertiesOfType(type).length > 0 ||
      this.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
      this.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
    );
  }
}
