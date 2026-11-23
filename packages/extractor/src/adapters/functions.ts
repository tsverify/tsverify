/**
 * `functions` persistence: the app's own storage functions, named in the spec's
 * `bindings.storage` (`StorageBinding`). tsverify treats them as the storage boundary and never
 * looks inside them. A call to one is recognized by the callee's **resolved symbol** (through
 * imports, re-exports, aliased and namespace imports), never by its name, and becomes the client
 * call `storage.<symbol>` (`client: "storage"`, `path: <symbol>`).
 *
 * ```ts
 * const order = await getOrder(id);                // read: the call's result is the entity
 * if (order?.status !== "paid") throw …;           // check (narrowing, as for every adapter)
 * order.status = "refunded";                       // write …
 * await saveOrder(order);                          // … committed by a save of that entity
 * await patchOrder(id, { status: "refunded" });    // save [key, patch]: the patch is the write
 * if (!(await setStatusIf(id, "paid", "refunded"))) throw …; // update: write + commit, atomic
 * await withTransaction(async () => { … });        // atomic: read and commit inside, as declared
 * ```
 *
 * **Writes**, by kind:
 * - `assign` / `spread` (`writes.ts`) on an entity: the read is the bound `read` call the
 *   reference was initialized with (directly, through helpers that return it, or, for a helper's
 *   parameter, at every call site that leads to it); the commit is the first later bound `save`
 *   call that takes the reference in its `entity` (or `patch`) argument, in the write's frame,
 *   in a helper it is passed to, or after the call that leads to the write in a caller. A spread
 *   passed straight to a bound save is committed by that call.
 * - `patch` (`writes.ts`): an object literal with the state field in the `patch` (or `entity`)
 *   argument of a bound save is the write and the call its commit, like Prisma's
 *   `data: { status }`. Its from-state is the narrowed state of the probed reference at the call
 *   (the closest preceding `const X = await <read>(…)`); with no such read nothing checks the
 *   stored state, so it is every state (`unconstrained`), and one call (atomic, no scope).
 * - `update` (found here, by symbol: `extraWrites`): a call to a bound conditional save is the
 *   write and the commit, atomic on its own (`conditional-update`, gate = the call's). The target
 *   is the `to` argument's literal type (or the fixed `to`), the from-states the `from`
 *   argument's: a string literal, a literal union, or an array or tuple of literals (or the fixed
 *   `from`). The read, when there is one, is the latest bound read before it, in the same frame,
 *   with the same key.
 *
 * **Atomicity.** A read and its commit are atomic (`declared`, at the bound atomic call, gate
 * `storage.<symbol>`) when both run inside the `callback` argument of one bound `atomic` call:
 * lexically, or in a helper every call path from the impl reaches from inside that callback. A
 * read outside and a commit inside, or the reverse, is not atomic. tsverify does not check what
 * the atomic function does: it is atomic because the spec says so.
 *
 * **The "check failed, stop" branch** (`effectOutcome`). A conditional save tells the caller
 * whether it saved (`returns`: `changed` → `false`, `count` → `0`, `entity` → `undefined`,
 * `throws` → it throws). Effects in the branch that runs only after a failed save
 * (`if (!(await setStatusIf(…))) { await email.send(…); return; }`) are not the transition's.
 * Effects that can run although the save failed (before it, or after it but before its result
 * is checked, `const ok = await setStatusIf(…); await stripe.refunds.create(…); if (!ok) …`)
 * escape the atomic step: the transition is then not atomic, with an `atomicNote` saying so.
 * This mirrors the other adapters, where a check that throws inside the transaction or a
 * `return undefined` followed by `if (x === undefined) return` stop the transition: here the
 * result tests `!r`, `r === false | 0 | undefined | null`, `r < 1`, their negations, and
 * `&&` / `||` of them, on the call itself or on a `const` holding it, decide the branch. A helper
 * passes the outcome to its callers when it throws on failure, or returns the save's result.
 *
 * **Anything else.** A write that no bound save commits (it goes to an unbound data layer), or
 * a patch passed to an unbound function, is `unanalyzable` (`PersistenceFacts.unbound`). A raw
 * query that sets the state without any field write is not seen at all (the spec transition is
 * then `missing-transition`).
 *
 * Storage: `{ client: "storage", collection: <entity name>, key: <StorageBinding.key> }`.
 * Entity key: the `key` argument of the read, the patch save or the update.
 */
import type {
  EntityDecl,
  FromState,
  StorageBinding,
  StorageFunction,
  StorageKind,
  StorageRole,
} from "@tsverify/ir";
import { type Callees, frameCalls, frameOf, leadsTo, MAX_DEPTH, type Reach } from "../callgraph";
import { type FunctionLike, inlineCallbackCall, isFunctionLike } from "../cfg";
import type { ClientCall } from "../client-calls";
import { primaryDeclarationOf, valueDeclarationOf } from "../declarations";
import { functionOfDeclaration, symbolOf } from "../resolve";
import type * as TS from "../ts-types";
import { alwaysExits, blockStatements, literalsOf, typeNames } from "../type-facts";
import { ts } from "../typescript";
import { referenceText, unwrapArgument, type WriteNode } from "../writes";
import { returnedExpressions, throughLocal } from "./assign";
import type {
  AdapterInput,
  EffectInput,
  EffectOutcome,
  LinkAtomicity,
  LinkInput,
  PersistenceAdapter,
  PersistenceFacts,
} from "./types";

export const STORAGE_CLIENT = "storage";

/** One bound storage function. */
export interface BoundFunction {
  kind: StorageKind;
  fn: StorageFunction;
  /** The bound symbol as written (`getOrder`, `repo.get`): the call path. */
  path: string;
}

function strip(e: TS.Expression): TS.Expression {
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

function forEachDescendant(node: TS.Node, visit: (n: TS.Node) => void): void {
  node.forEachChild((c) => {
    visit(c);
    forEachDescendant(c, visit);
  });
}

/** Calls to the bound storage functions, by the callee's resolved symbol. */
export class StorageFunctions {
  private readonly memo = new Map<TS.CallExpression, BoundFunction | null>();
  private readonly byPath = new Map<string, BoundFunction>();
  /** The bound functions' own code, which tsverify never looks into. */
  private readonly bodies: TS.Node[] = [];

  constructor(
    private readonly checker: TS.Checker,
    private readonly bySymbol: ReadonlyMap<TS.Symbol, BoundFunction>,
  ) {
    for (const [sym, b] of bySymbol) {
      this.byPath.set(b.path, b);
      const decl = primaryDeclarationOf(sym);
      const body = functionOfDeclaration(decl) ?? decl;
      if (body) this.bodies.push(body);
    }
  }

  /** Whether `node` is inside a bound function's own code. */
  inside(node: TS.Node): boolean {
    const sf = node.getSourceFile();
    return this.bodies.some(
      (b) => b.getSourceFile() === sf && node.pos >= b.pos && node.end <= b.end,
    );
  }

  /** The bound function `call` calls, if any. */
  of(call: TS.CallExpression): BoundFunction | undefined {
    const cached = this.memo.get(call);
    if (cached !== undefined) return cached ?? undefined;
    let callee: TS.Expression = call.expression;
    while (ts.isParenthesizedExpression(callee) || ts.isNonNullExpression(callee)) {
      callee = callee.expression;
    }
    let found: BoundFunction | undefined;
    if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
      const sym = symbolOf(callee, this.checker);
      found = sym && this.bySymbol.get(sym);
    }
    this.memo.set(call, found ?? null);
    return found;
  }

  /** The bound function with this path (symbol text). */
  path(path: string): BoundFunction | undefined {
    return this.byPath.get(path);
  }

  /** `call` as a `storage.<symbol>` client call, when it calls a bound function. */
  clientCall(call: TS.CallExpression): ClientCall | undefined {
    const b = this.of(call);
    return b && { call, client: STORAGE_CLIENT, path: b.path, gate: `${STORAGE_CLIENT}.${b.path}` };
  }
}

/** The argument with `role`, unwrapped (probe commas, parentheses). */
function argAt(
  call: TS.CallExpression,
  fn: StorageFunction,
  role: StorageRole,
): TS.Expression | undefined {
  const i = fn.args.indexOf(role);
  const a = i < 0 ? undefined : call.arguments[i];
  if (!a || ts.isSpreadElement(a)) return undefined;
  return unwrapArgument(a) as TS.Expression;
}

function argIndexOf(call: TS.CallExpression, node: TS.Node): number {
  return call.arguments.findIndex((a) => unwrapArgument(a) === node);
}

/** Two references to the same thing: one symbol, or the same `a.b.c` text. */
function sameRef(a: TS.Expression, b: TS.Expression, checker: TS.Checker): boolean {
  const x = strip(a);
  const y = strip(b);
  if (ts.isIdentifier(x) && ts.isIdentifier(y)) {
    const sx = symbolOf(x, checker);
    return sx !== undefined && sx === symbolOf(y, checker);
  }
  const tx = referenceText(x);
  return tx !== undefined && tx === referenceText(y);
}

/** The literal states an expression stands for: a literal, a literal union, an array or tuple of them. */
function stateList(e: TS.Expression, checker: TS.Checker): string[] | undefined {
  const s = strip(e);
  if (ts.isStringLiteral(s) || ts.isNoSubstitutionTemplateLiteral(s)) return [s.text];
  if (ts.isArrayLiteralExpression(s)) {
    const out: string[] = [];
    for (const el of s.elements) {
      if (ts.isSpreadElement(el)) return undefined;
      const v = stateList(el, checker);
      if (!v) return undefined;
      out.push(...v);
    }
    return out;
  }
  const type = checker.getTypeAtLocation(s);
  if (!type) return undefined;
  return typeStates(type, checker);
}

function typeStates(type: TS.Type, checker: TS.Checker): string[] | undefined {
  if (checker.isTupleType(type) || checker.isArrayType(type)) {
    const out: string[] = [];
    for (const t of checker.getTypeArguments(
      type as Parameters<TS.Checker["getTypeArguments"]>[0],
    )) {
      const v = typeStates(t, checker);
      if (!v) return undefined;
      out.push(...v);
    }
    return out;
  }
  if (type.isUnionType()) {
    const out: string[] = [];
    for (const t of type.getTypes()) {
      const v = typeStates(t, checker);
      if (!v) return undefined;
      out.push(...v);
    }
    return out;
  }
  const lits = literalsOf(type, checker);
  return lits === "*" ? undefined : [...lits];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// --- the "check failed, stop" branch ---------------------------------------------------------

type Outcome = "success" | "fail";

function flip(o: Outcome | undefined): Outcome | undefined {
  return o === undefined ? undefined : o === "success" ? "fail" : "success";
}

type Literal = boolean | number | null | undefined;
const NOT_LITERAL = Symbol("not a literal");

function literalOf(e: TS.Expression): Literal | typeof NOT_LITERAL {
  const s = strip(e);
  if (s.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (s.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (s.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(s) && s.text === "undefined") return undefined;
  if (ts.isNumericLiteral(s)) return Number(s.text);
  return NOT_LITERAL;
}

/** What `subject === lit` says about a conditional save, by what it returns. */
function equalsOutcome(lit: Literal, returns: StorageFunction["returns"]): Outcome | undefined {
  switch (returns ?? "changed") {
    case "changed":
      return lit === true ? "success" : lit === false ? "fail" : undefined;
    case "count":
      return typeof lit === "number" ? (lit > 0 ? "success" : "fail") : undefined;
    case "entity":
      return lit === undefined || lit === null ? "fail" : undefined;
    default:
      return undefined;
  }
}

/**
 * What `cond` evaluating to `value` implies about the save's outcome, when it tests the save's
 * result (`isSubject`); undefined when it says nothing.
 */
function implied(
  cond: TS.Expression,
  value: boolean,
  isSubject: (e: TS.Expression) => boolean,
  returns: StorageFunction["returns"],
): Outcome | undefined {
  const e = strip(cond);
  if (isSubject(e)) return value ? "success" : "fail";
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return implied(e.operand, !value, isSubject, returns);
  }
  if (!ts.isBinaryExpression(e)) return undefined;
  const op = e.operatorToken.kind;
  const K = ts.SyntaxKind;
  if (op === K.AmpersandAmpersandToken) {
    if (!value) return undefined;
    return implied(e.left, true, isSubject, returns) ?? implied(e.right, true, isSubject, returns);
  }
  if (op === K.BarBarToken) {
    if (value) return undefined;
    return (
      implied(e.left, false, isSubject, returns) ?? implied(e.right, false, isSubject, returns)
    );
  }
  let subjectLeft: boolean;
  if (isSubject(strip(e.left))) subjectLeft = true;
  else if (isSubject(strip(e.right))) subjectLeft = false;
  else return undefined;
  const lit = literalOf(subjectLeft ? e.right : e.left);
  if (lit === NOT_LITERAL) return undefined;
  const equality =
    op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken
      ? true
      : op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken
        ? false
        : undefined;
  if (equality !== undefined) {
    const eq = equalsOutcome(lit, returns);
    // A conditional save has two outcomes, so `r !== false` is a success.
    return value === equality ? eq : flip(eq);
  }
  if (typeof lit !== "number" || (returns ?? "changed") !== "count") return undefined;
  // `count > 0`, `count >= 1` (subject on the left; mirrored when on the right).
  let gt: boolean;
  let threshold: number;
  if (op === K.GreaterThanToken || op === K.LessThanToken) {
    gt = (op === K.GreaterThanToken) === subjectLeft;
    threshold = lit;
  } else if (op === K.GreaterThanEqualsToken || op === K.LessThanEqualsToken) {
    gt = (op === K.GreaterThanEqualsToken) === subjectLeft;
    threshold = gt ? lit - 1 : lit + 1;
  } else return undefined;
  // gt: `count > threshold`, else `count < threshold`.
  const success = gt ? threshold >= 0 && threshold < 1 : threshold === 1;
  const fail = gt ? false : threshold === 1;
  const when: Outcome | undefined = success ? "success" : fail ? "fail" : undefined;
  return value ? when : flip(when);
}

/** Whether a statement always ends with `throw` (not a `return`). */
function alwaysThrows(st: TS.Statement): boolean {
  if (ts.isThrowStatement(st)) return true;
  if (ts.isBlock(st)) {
    for (const s of st.statements) {
      if (alwaysThrows(s)) return true;
      if (alwaysExits(s)) return false;
    }
    return false;
  }
  if (ts.isIfStatement(st)) {
    return (
      st.elseStatement !== undefined &&
      alwaysThrows(st.thenStatement) &&
      alwaysThrows(st.elseStatement)
    );
  }
  return false;
}

/**
 * Where `node` runs relative to the save's result, read from the statements enclosing it in its
 * function: inside a branch, or after an early exit, that a result test decides.
 */
function branchOutcome(
  node: TS.Node,
  fn: FunctionLike,
  isSubject: (e: TS.Expression) => boolean,
  returns: StorageFunction["returns"],
): Outcome | undefined {
  const test = (cond: TS.Expression, value: boolean) => implied(cond, value, isSubject, returns);
  for (let n = node; n.parent && n !== fn; n = n.parent) {
    const parent = n.parent;
    let o: Outcome | undefined;
    if (ts.isIfStatement(parent) && n !== parent.expression) {
      o = test(parent.expression, n === parent.thenStatement);
    } else if (ts.isConditionalExpression(parent) && n !== parent.condition) {
      o = test(parent.condition, n === parent.whenTrue);
    } else if (
      ts.isBinaryExpression(parent) &&
      n === parent.right &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      o = test(parent.left, true);
    } else if (
      ts.isBinaryExpression(parent) &&
      n === parent.right &&
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      o = test(parent.left, false);
    } else {
      for (const st of blockStatements(parent) ?? []) {
        if (st === n) break;
        if (!ts.isIfStatement(st)) continue;
        const thenExits = alwaysExits(st.thenStatement);
        const elseExits = st.elseStatement !== undefined && alwaysExits(st.elseStatement);
        if (thenExits !== elseExits) o ??= test(st.expression, elseExits);
      }
    }
    if (o) return o;
    if (isFunctionLike(parent) && !inlineCallbackCall(parent)) return undefined;
  }
  return undefined;
}

/** How a frame on the path to the save lets its callers know the save failed. */
type Propagation = "throws" | "returns" | "none";

// --- the adapter -----------------------------------------------------------------------------

export interface FunctionsAdapterInput {
  binding: StorageBinding;
  fns: StorageFunctions;
  callees: Callees;
  checker: TS.Checker;
  entity: EntityDecl;
}

interface Scope {
  call: TS.CallExpression;
  gate: string;
}

export function functionsAdapter(input: FunctionsAdapterInput): PersistenceAdapter {
  const { binding, fns, callees, checker, entity } = input;
  const storage = { client: STORAGE_CLIENT, collection: entity.name, key: binding.key };
  const field = entity.stateField;
  const kinds = (b: BoundFunction | undefined) => b?.kind;
  const gateOf = (b: BoundFunction) => `${STORAGE_CLIENT}.${b.path}`;
  const kindList = "`bindings.storage` (`read`, `save`, `update` or `atomic`)";

  /** The bound read `call` performs: itself, or the read a helper it calls returns. */
  const readThrough = (call: TS.CallExpression, depth: number): ClientCall | undefined => {
    const b = fns.of(call);
    if (b) return b.kind === "read" ? fns.clientCall(call) : undefined;
    if (depth >= MAX_DEPTH) return undefined;
    const callee = callees.of(call);
    if (!callee) return undefined;
    for (const r of returnedExpressions(callee)) {
      const e = throughLocal(strip(r), callee, checker);
      if (!ts.isCallExpression(e)) continue;
      const found = readThrough(e, depth + 1);
      if (found) return found;
    }
    return undefined;
  };

  /**
   * The read an entity reference comes from: the call its `const` was initialized with, or, for
   * a parameter of `frame`, the read every call site in `reach` passes (they must agree).
   */
  const readOfRef = (
    ref: TS.Expression,
    frame: FunctionLike | undefined,
    reach: Reach | undefined,
    depth: number,
  ): ClientCall | undefined => {
    const e = strip(ref);
    if (!ts.isIdentifier(e) || depth > MAX_DEPTH) return undefined;
    const decl = valueDeclarationOf(symbolOf(e, checker));
    if (!decl) return undefined;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = strip(decl.initializer);
      return ts.isCallExpression(init) ? readThrough(init, 0) : undefined;
    }
    if (!ts.isParameter(decl) || !reach || !frame || decl.parent !== frame) return undefined;
    const index = frame.parameters.indexOf(decl);
    let agreed: ClientCall | undefined;
    for (const edge of reach.edges) {
      if (edge.callee !== frame) continue;
      const arg = edge.call.arguments[index];
      const read = arg && !ts.isSpreadElement(arg) && readOfRef(arg, edge.caller, reach, depth + 1);
      if (!read || (agreed && agreed.call !== read.call)) return undefined;
      agreed = read;
    }
    return agreed;
  };

  /** A bound save among `calls` (after `after`) that takes `ref` as its entity or patch. */
  const saveOf = (
    calls: readonly TS.CallExpression[],
    after: number,
    takes: (a: TS.Expression) => boolean,
    depth: number,
  ): ClientCall | undefined => {
    for (const call of calls) {
      if (call.getStart() < after) continue;
      const b = fns.of(call);
      if (b) {
        if (b.kind !== "save") continue;
        const arg = argAt(call, b.fn, "entity") ?? argAt(call, b.fn, "patch");
        if (arg && takes(arg)) return fns.clientCall(call);
        continue;
      }
      if (depth >= MAX_DEPTH) continue;
      // A helper the reference is passed to: its save of that parameter.
      const callee = callees.of(call);
      if (!callee) continue;
      const index = call.arguments.findIndex((a) => !ts.isSpreadElement(a) && takes(a));
      const param = callee.parameters[index];
      if (index < 0 || !param || !ts.isIdentifier(param.name)) continue;
      const paramSym = symbolOf(param.name, checker);
      const inner = saveOf(
        frameCalls(callee),
        -1,
        (a) => ts.isIdentifier(strip(a)) && symbolOf(strip(a), checker) === paramSym,
        depth + 1,
      );
      if (inner) return inner;
    }
    return undefined;
  };

  /**
   * The commit of an assignment: a later save of the reference in the write's frame, else (a
   * helper's parameter) after the call that leads to the write in each caller (all must agree).
   */
  const commitOfRef = (
    write: WriteNode,
    frame: FunctionLike,
    reach: Reach | undefined,
  ): ClientCall | undefined => {
    const own = saveOf(
      frameCalls(frame),
      write.expr.getEnd(),
      (a) => sameRef(a, write.ref, checker),
      0,
    );
    if (own || !reach) return own;
    const ref = strip(write.ref);
    const decl = ts.isIdentifier(ref) ? valueDeclarationOf(symbolOf(ref, checker)) : undefined;
    if (!decl || !ts.isParameter(decl) || decl.parent !== frame) return undefined;
    const index = frame.parameters.indexOf(decl);
    let agreed: ClientCall | undefined;
    for (const edge of reach.edges) {
      if (edge.callee !== frame) continue;
      const arg = edge.call.arguments[index];
      if (!arg || ts.isSpreadElement(arg)) return undefined;
      const found = saveOf(
        frameCalls(edge.caller),
        edge.call.getEnd(),
        (a) => sameRef(a, arg, checker),
        0,
      );
      if (!found || (agreed && agreed.call !== found.call)) return undefined;
      agreed = found;
    }
    return agreed;
  };

  /** The bound atomic callback `node` runs in, along every call path of `reach`. */
  const scopeOf = (
    node: TS.Node,
    reach: Reach | undefined,
    stack: Set<FunctionLike> = new Set(),
  ): Scope | undefined => {
    const frame = frameOf(node);
    if (!frame) return undefined;
    for (let p = node.parent; p && p !== frame; p = p.parent) {
      if (!ts.isArrowFunction(p) && !ts.isFunctionExpression(p)) continue;
      const call = inlineCallbackCall(p);
      if (!call || !ts.isCallExpression(call)) continue;
      const b = fns.of(call);
      if (b?.kind !== "atomic" || b.fn.args[argIndexOf(call, p)] !== "callback") continue;
      return { call, gate: gateOf(b) };
    }
    if (!reach || frame === reach.root || stack.has(frame)) return undefined;
    stack.add(frame);
    let agreed: Scope | undefined;
    let ok = true;
    for (const edge of reach.edges) {
      if (edge.callee !== frame) continue;
      const s = scopeOf(edge.call, reach, stack);
      if (!s || (agreed && agreed.call !== s.call)) {
        ok = false;
        break;
      }
      agreed = s;
    }
    stack.delete(frame);
    return ok ? agreed : undefined;
  };

  const noRead = (what: string): string =>
    `no read of \`${what}\` through a \`bindings.storage.read\` function was found before this write, so atomicity cannot be decided (reported as not atomic)`;

  const unbound = (message: string): PersistenceFacts["unbound"] => ({
    message,
    hint: `Read and save the ${entity.name} through the functions named in ${kindList}, or name the function this write goes through there.`,
  });

  /** The facts of a write; with `reach`, also through the impl's call paths. */
  const factsOf = (
    write: WriteNode,
    frame: FunctionLike,
    reach: Reach | undefined,
  ): PersistenceFacts => {
    const base = { storage, problems: [] as string[] };

    if (write.kind === "update") {
      const call = write.call as TS.CallExpression;
      const b = fns.of(call) as BoundFunction;
      const commit = fns.clientCall(call) as ClientCall;
      const key = argAt(call, b.fn, "key");
      const fromArg = argAt(call, b.fn, "from");
      const states = b.fn.from ?? (fromArg ? stateList(fromArg, checker) : undefined);
      const fromState: FromState = states
        ? {
            values: uniqueSorted(states),
            unconstrained: entity.states.every((s) => states.includes(s)),
          }
        : {
            values: "*",
            unconstrained: false,
            reason: `the \`from\` argument of ${commit.gate} (${fromArg?.getText() ?? "missing"}) is not a literal state or a list of them`,
          };
      // The read that the code checked before the save: the latest one with the same key.
      let read: ClientCall | undefined;
      if (key) {
        for (const c of frameCalls(frame)) {
          if (c.getStart() >= call.getStart()) break;
          const rb = fns.of(c);
          const rk = rb?.kind === "read" ? argAt(c, rb.fn, "key") : undefined;
          if (rk && sameRef(rk, key, checker)) read = fns.clientCall(c);
        }
      }
      return {
        ...base,
        ...(read ? { read } : {}),
        commit,
        atomic: true,
        atomicAt: { kind: "conditional-update", call, gate: commit.gate },
        fromState,
        ...(key ? { entityKey: key } : {}),
      };
    }

    if (write.kind === "patch") {
      const call = write.call as TS.CallExpression;
      const b = fns.of(call);
      if (b?.kind !== "save") {
        return {
          ...base,
          atomic: false,
          unbound: unbound(
            `${entity.name}.${field} is written in a patch passed to \`${call.expression.getText()}\`, which is not a \`bindings.storage.save\` function`,
          ),
        };
      }
      const commit = fns.clientCall(call) as ClientCall;
      const key = argAt(call, b.fn, "key");
      const keyFacts = key ? { entityKey: key } : {};
      if (!write.probed) {
        return {
          ...base,
          commit,
          atomic: true,
          fromState: {
            values: [...entity.states].sort(),
            unconstrained: true,
            reason: `nothing checks the stored ${field} before ${commit.gate}: no read of the ${entity.name} precedes it`,
          },
          ...keyFacts,
        };
      }
      const read = readOfRef(write.ref, frame, reach, 0);
      return {
        ...base,
        ...(read ? { read } : {}),
        commit,
        atomic: false,
        ...keyFacts,
        ...(!key && read
          ? { entityKey: argAt(read.call, (fns.of(read.call) as BoundFunction).fn, "key") }
          : {}),
        problems: read ? [] : [noRead(write.ref.getText())],
      };
    }

    // assign / spread on an entity reference.
    const refText = referenceText(write.ref) ?? write.ref.getText();
    const read = readOfRef(write.ref, frame, reach, 0);
    let commit: ClientCall | undefined;
    let unboundCall: TS.CallExpression | undefined;
    if (write.kind === "spread") {
      let parent: TS.Node = write.expr.parent;
      while (ts.isParenthesizedExpression(parent) || ts.isBinaryExpression(parent)) {
        parent = parent.parent;
      }
      if (ts.isCallExpression(parent)) {
        const b = fns.of(parent);
        const index = argIndexOf(parent, write.expr);
        const role = b?.fn.args[index];
        if (b?.kind === "save" && (role === "entity" || role === "patch")) {
          commit = fns.clientCall(parent);
        } else if (!b) unboundCall = parent;
      }
    } else {
      commit = commitOfRef(write, frame, reach);
    }
    const readKey = read && argAt(read.call, (fns.of(read.call) as BoundFunction).fn, "key");
    const commitBound = commit && (fns.of(commit.call) as BoundFunction);
    const commitKey = commit && commitBound && argAt(commit.call, commitBound.fn, "key");
    const entityKey = readKey ?? commitKey;
    const facts: PersistenceFacts = {
      ...base,
      ...(read ? { read } : {}),
      ...(commit ? { commit } : {}),
      atomic: false,
      ...(entityKey ? { entityKey } : {}),
      problems: read ? [] : [noRead(refText)],
    };
    if (!commit) {
      facts.unbound = unbound(
        unboundCall
          ? `${entity.name}.${field} is written in an object passed to \`${unboundCall.expression.getText()}\`, which is not a \`bindings.storage.save\` function`
          : `no \`bindings.storage.save\` call saves \`${refText}\` after this write, so tsverify cannot tell where it is stored`,
      );
    }
    return facts;
  };

  const linkAtomicity = ({ write, frame, reach }: LinkInput): LinkAtomicity => {
    const facts = factsOf(write, frame, reach);
    const overrides = {
      facts: {
        ...(facts.read ? { read: facts.read } : {}),
        ...(facts.commit ? { commit: facts.commit } : {}),
        ...(facts.entityKey ? { entityKey: facts.entityKey } : {}),
        problems: facts.problems,
        ...(facts.unbound ? { unbound: facts.unbound } : {}),
      },
    };
    if (facts.atomicAt) {
      return {
        atomic: true,
        kind: facts.atomicAt.kind,
        at: facts.atomicAt.call,
        gate: facts.atomicAt.gate,
        ...overrides,
      };
    }
    if (facts.atomic) return { atomic: true, ...overrides };
    if (facts.read && facts.commit) {
      const r = scopeOf(facts.read.call, reach);
      const c = scopeOf(facts.commit.call, reach);
      if (r && c && r.call === c.call) {
        return { atomic: true, kind: "declared", at: r.call, gate: r.gate, ...overrides };
      }
    }
    return { atomic: false, ...overrides };
  };

  const effectOutcome = ({ call, write, frame, reach }: EffectInput): EffectOutcome => {
    if (write.kind !== "update") return "attributed";
    const save = write.call as TS.CallExpression;
    const returns = (fns.of(save) as BoundFunction).fn.returns ?? "changed";
    const leads = leadsTo(reach, frame, write.expr);

    const subjectOf =
      (subject: TS.CallExpression) =>
      (e: TS.Expression): boolean => {
        const s = strip(e);
        if (s === subject) return true;
        if (!ts.isIdentifier(s)) return false;
        const decl = valueDeclarationOf(symbolOf(s, checker));
        return (
          decl !== undefined &&
          ts.isVariableDeclaration(decl) &&
          decl.initializer !== undefined &&
          strip(decl.initializer) === subject
        );
      };

    /** How `fn` (on the path to the save, through `lead`) reports a failed save to its callers. */
    const propagationMemo = new Map<FunctionLike, Propagation>();
    const propagation = (fn: FunctionLike, stack: Set<FunctionLike>): Propagation => {
      const cached = propagationMemo.get(fn);
      if (cached) return cached;
      if (stack.has(fn)) return "none";
      stack.add(fn);
      let result: Propagation = "none";
      for (const g of leads(fn)) {
        let subject: TS.CallExpression | undefined;
        if (!g.callee) {
          if (returns === "throws") {
            result = "throws";
            break;
          }
          subject = save;
        } else {
          const inner = propagation(g.callee, stack);
          if (inner === "throws") {
            result = "throws";
            break;
          }
          if (inner === "returns" && ts.isCallExpression(g.node)) subject = g.node;
        }
        if (!subject) continue;
        const isSubject = subjectOf(subject);
        let throws = false;
        let returnsResult = false;
        const visit = (n: TS.Node): void => {
          if ((isFunctionLike(n) && !inlineCallbackCall(n)) || ts.isClassLike(n)) return;
          if (ts.isIfStatement(n) && n.getStart() >= subject.getStart()) {
            const thenFail = implied(n.expression, true, isSubject, returns) === "fail";
            const elseFail = implied(n.expression, false, isSubject, returns) === "fail";
            if (thenFail && alwaysThrows(n.thenStatement)) throws = true;
            if (elseFail && n.elseStatement && alwaysThrows(n.elseStatement)) throws = true;
          }
          if (ts.isReturnStatement(n) && n.expression && isSubject(n.expression)) {
            returnsResult = true;
          }
          n.forEachChild(visit);
        };
        if (fn.body && !ts.isBlock(fn.body)) returnsResult ||= isSubject(fn.body);
        else fn.body?.forEachChild(visit);
        if (throws) {
          result = "throws";
          break;
        }
        if (returnsResult) result = "returns";
      }
      stack.delete(fn);
      propagationMemo.set(fn, result);
      return result;
    };

    const outcomeAt = (
      node: TS.Node,
      fn: FunctionLike,
      stack: Set<FunctionLike>,
    ): EffectOutcome => {
      const groups = leads(fn);
      if (groups.length === 0) {
        // A frame called from attributed call sites: as those call sites.
        if (stack.has(fn)) return "attributed";
        stack.add(fn);
        const outcomes = reach.edges
          .filter((e) => e.callee === fn)
          .map((e) => outcomeAt(e.call, e.caller, stack));
        stack.delete(fn);
        if (outcomes.includes("unchecked")) return "unchecked";
        if (outcomes.length > 0 && outcomes.every((o) => o === "excluded")) return "excluded";
        return "attributed";
      }
      const before = groups.filter((g) => g.node.getEnd() <= node.getStart());
      if (before.length === 0) return "unchecked"; // runs before the save
      const lead = before[before.length - 1] as (typeof groups)[number];
      let subject: TS.CallExpression | undefined;
      if (!lead.callee) subject = save;
      else {
        const p = propagation(lead.callee, new Set());
        if (p === "throws") return "attributed";
        if (p === "returns" && ts.isCallExpression(lead.node)) subject = lead.node;
      }
      if (!subject) return "unchecked";
      if (!lead.callee && returns === "throws") return "attributed";
      const o = branchOutcome(node, fn, subjectOf(subject), returns);
      return o === "success" ? "attributed" : o === "fail" ? "excluded" : "unchecked";
    };

    const callFrame = frameOf(call.call);
    return callFrame ? outcomeAt(call.call, callFrame, new Set()) : "attributed";
  };

  return {
    kind: "functions",
    writeKinds: new Set(["assign", "spread", "patch", "update"]),
    scopeAliasParam: -1,
    readHint: `Read the ${entity.name} with a \`bindings.storage.read\` function in the same function as the write, or in a helper that returns it.`,

    scopeKind(path, argIndex) {
      const b = fns.path(path);
      return b?.kind === "atomic" && b.fn.args[argIndex] === "callback" ? "declared" : undefined;
    },

    matchEntity(write) {
      // The storage boundary: what a bound function does inside is not the app's transition.
      if (fns.inside(write.expr)) return false;
      if (write.kind === "update") return true;
      if (write.kind !== "patch") return undefined;
      const call = write.call as TS.CallExpression;
      const b = fns.of(call);
      if (b) {
        const role = b.fn.args[argIndexOf(call, write.expr)];
        return b.kind === "save" && (role === "patch" || role === "entity");
      }
      // An unbound function: the patch is the entity's when its parameter is typed so.
      const contextual = checker.getContextualType(write.expr);
      if (!contextual) return false;
      return typeNames(contextual, checker).includes(entity.name);
    },

    extraWrites(files) {
      const out: WriteNode[] = [];
      for (const sf of files) {
        forEachDescendant(sf, (n) => {
          if (!ts.isCallExpression(n) || kinds(fns.of(n)) !== "update" || fns.inside(n)) return;
          const b = fns.of(n) as BoundFunction;
          const to = argAt(n, b.fn, "to");
          const key = argAt(n, b.fn, "key");
          out.push({
            kind: "update",
            field,
            expr: n,
            site: n,
            ref: key ?? n,
            value: to ?? n,
            call: n,
            ...(b.fn.to !== undefined ? { fixedValue: b.fn.to } : {}),
          });
        });
      }
      return out;
    },

    analyzeWrite(adapterInput: AdapterInput): PersistenceFacts {
      return factsOf(adapterInput.write, adapterInput.frame, undefined);
    },

    linkAtomicity,
    effectOutcome,
  };
}
