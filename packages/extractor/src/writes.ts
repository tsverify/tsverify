/**
 * State-write discovery. Phase 1 (`findCandidateWrites`) is purely syntactic so every probe can be
 * planned before the first type query; phase 2 (`rebindWrites`) re-finds the same writes in the
 * probed program, where all later analysis happens.
 *
 * A candidate write is
 * - an assignment `x.<field> = v` (plain `=` only), or
 * - an object literal `{ ...x, <field>: v }` passed directly as a call argument
 *   (`db.orders.save({ ...order, status: "refunded" })`); `x` is the last spread before the field, or
 * - (`data`, the ORM shape) the `<field>` property of the update object of an update call:
 *   `<chain>.update|updateMany|updateManyAndReturn({ …, data: { <field>: v } })` or
 *   `<chain>.upsert({ …, update: { <field>: v } })`, where `v` may also be `{ set: v }`. The
 *   entity reference the narrowing probe reads is not part of the write, so it is chosen
 *   syntactically (`dataRefText`): `X` in `where: { id: X.id }`, else the closest
 *   `const X = await <chain>.<model>.find…(…)` on the same model declared before the call in an
 *   enclosing block. Without one there is no probe, and the write's `ref` is the update object.
 *
 * - (`patch`, named storage functions only: `PatchOptions`) an object literal passed directly as a
 *   call argument whose `<field>` property comes before any spread:
 *   `patchOrder(id, { status: "paid" })`. Like a `data` write, its probe reference is chosen
 *   syntactically (`patchRefText`): the closest `const X = await? <read>(…)` declared before the
 *   call in an enclosing block of its function, where `<read>` is a name that may be a bound read
 *   function (its symbol, or a local import alias of it). Phase 2 checks the symbol.
 * - (`held`, named storage functions only) the `<field>` property of an object literal that
 *   initializes a local variable, `const patch = { status: input.status, updatedAt: now }`, which
 *   the code passes to a call later (`tx.update(incident).set(patch)`). Its probe reference is
 *   chosen like a `patch` write's, from the declaration. Phase 2 (`adapters/functions.ts`) follows
 *   the variable to the call: a `const` used once, as that call's argument, is read like a `patch`
 *   write passed there directly; anything else (an object built up before the call, a field set
 *   on it afterwards: `patch.status = …`) is reported as `unanalyzable`.
 *
 * - (`data` / `spread`, held) the same objects held in a local variable first: an object literal
 *   initializing `const data = { status: "paid" }` that the function then uses as an update call's
 *   `data` (`prisma.order.update({ where: { id }, data })`) is a `data` write of that call; one with
 *   a spread before the field, `const next = { ...order, status: "paid" }`, passed to a call
 *   (`db.orders.save(next)`) is a `spread` write passed to it. The variable is followed by name,
 *   in the function that declares it (`heldUses`, syntax only, like everything in phase 1). A
 *   `const` used once that way, and otherwise only to read or set other fields, is read like the
 *   object written into the call; anything else (a `let`, several such uses, the state field set
 *   afterwards, other uses) is recorded in `WriteNode.held.issue`, and the write is reported as
 *   `unanalyzable` instead of extracted. (With named storage functions, such objects are `held`
 *   writes, above, unless they go to an update call's `data`.) An update's whole argument held
 *   first (`const args = { where, data: { status } }; prisma.order.update(args)`) is followed the
 *   same way (`heldArgsContext`, `updateArgsOf`). Objects whose state is set after they are built
 *   are never read, only reported (`held.issue`): an empty update object filled in
 *   (`const data = {}; data.status = "paid"`, then `data` of an update: a `data` write,
 *   `matchFilledDataWrite`), and, without named storage functions, the state set on a copy or an
 *   empty patch (`const next = { ...order }; next.status = …`: `builtUp`).
 *
 * A conditional save (`setStatusIf(id, from, to)`, kind `update`) is a state write with no field
 * written in the code: the named-function adapter finds those in phase 2, by symbol, since they
 * need no probe (`adapters/functions.ts`).
 *
 * Not candidates: `this.<field> = v` in a constructor (object initialization, not a transition),
 * and ORM `create` calls (they initialize a new entity, like a constructor).
 *
 * Whether a candidate belongs to a spec's entity is decided later, with types (`entity.ts`).
 */
import type * as TS from "./ts-types";
import { ts } from "./typescript";

export type WriteKind = "assign" | "spread" | "data" | "patch" | "held" | "update";

/**
 * Phase-1 options for `patch` candidates, set only when some spec names its own storage functions
 * (`bindings.storage`), so other projects find exactly the writes they did before.
 */
export interface PatchOptions {
  /** State fields of the specs with named storage functions. */
  fields: ReadonlySet<string>;
  /** Bound read functions' symbols (`getOrder`, `repo.get`): probe reference candidates. */
  readSymbols: readonly string[];
}

export interface CandidateWrite {
  kind: WriteKind;
  field: string;
  /** Absolute file name. */
  file: string;
  /** Original offsets of the expression a probe wraps (assignment, or object literal). */
  span: { start: number; end: number };
  /** Canonical probe reference text (`order`, `this`, `ctx.order`); absent when not re-evaluable. */
  ref?: string;
}

/** A candidate write located in the probed program. */
export interface WriteNode {
  kind: WriteKind;
  field: string;
  /** The assignment, or the object literal. */
  expr: TS.Expression;
  /** The reported write site: the assignment, or the `field: v` property. */
  site: TS.Node;
  /** The entity reference: assignment target object, or the spread expression. */
  ref: TS.Expression;
  /** The written value expression (`undefined` for a shorthand property: its identifier). */
  value: TS.Expression;
  /**
   * `data` writes: the update call (`prisma.order.update(…)`); `patch` writes: the call the
   * object is passed to; `update` writes: the conditional save call itself.
   */
  call?: TS.CallExpression;
  /** `data` / `patch` / `held` writes: whether `ref` is the probe's reference (else the object). */
  probed?: boolean;
  /** `update` writes with a fixed target (`to:` in the binding): the written state. */
  fixedValue?: string;
  /**
   * `data` / `spread` writes whose object is held in a local variable before `call` takes it
   * (see the module comment): the variable's name, and why the write can't be read as if
   * written into the call, when it can't (the write is then reported as `unanalyzable`).
   */
  held?: { name: string; issue?: string };
}

/** Update methods whose argument holds a `data`-shaped object, and the keys that hold it. */
export const DATA_WRITE_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["update", ["data"]],
  ["updateMany", ["data"]],
  ["updateManyAndReturn", ["data"]],
  ["upsert", ["update"]],
]);

/** ORM reads whose result can be the entity a later update checks. */
export const FIND_METHODS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
]);

function forEachDescendant(node: TS.Node, visit: (n: TS.Node) => void): void {
  node.forEachChild((c) => {
    visit(c);
    forEachDescendant(c, visit);
  });
}

function skipParens(n: TS.Node): TS.Node {
  let cur = n;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function isCommaRight(p: TS.Node, child: TS.Node): boolean {
  return (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    p.right === child
  );
}

/** Parent, skipping parentheses and the `(probe, W)` comma a probe wraps `W` in. */
export function parentSkippingWrappers(n: TS.Node): TS.Node {
  let child = n;
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || isCommaRight(p, child))) {
    child = p;
    p = p.parent;
  }
  return p;
}

/** Strips parentheses and `(probe, W)` commas from an argument. */
export function unwrapArgument(a: TS.Node): TS.Node {
  let cur = a;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      cur = cur.right;
    } else return cur;
  }
}

/** `a`, `this`, `a.b.c` → canonical text; anything else (calls, element access, `?.`) → undefined. */
export function referenceText(expr: TS.Expression): string | undefined {
  const e = skipParens(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.name)) {
    const inner = referenceText(e.expression);
    return inner === undefined ? undefined : `${inner}.${e.name.text}`;
  }
  return undefined;
}

function propertyName(p: TS.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return undefined;
  const name = p.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** `this.<field> = v` directly in a constructor body initializes a new object: not a transition. */
function isConstructorInit(target: TS.PropertyAccessExpression): boolean {
  if (target.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  for (let p: TS.Node | undefined = target.parent; p; p = p.parent) {
    if (ts.isConstructorDeclaration(p)) return true;
    if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) return false;
  }
  return false;
}

function stripValue(e: TS.Expression): TS.Expression {
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

/** The property `name` of an object literal (a plain or shorthand property assignment). */
export function propertyNamed(
  o: TS.ObjectLiteralExpression,
  name: string,
): TS.PropertyAssignment | TS.ShorthandPropertyAssignment | undefined {
  for (const p of o.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    if (propertyName(p) === name) return p;
  }
  return undefined;
}

/**
 * `data`-write context of an object literal: the update call and its first argument. `held` is
 * set when that argument is held in a local variable first (`heldArgsContext`).
 */
function dataContext(n: TS.ObjectLiteralExpression):
  | {
      call: TS.CallExpression;
      args: TS.ObjectLiteralExpression;
      held?: NonNullable<WriteNode["held"]>;
    }
  | undefined {
  const prop = parentSkippingWrappers(n);
  if (!prop || !ts.isPropertyAssignment(prop) || unwrapArgument(prop.initializer) !== n) {
    return undefined;
  }
  return dataContextOf(prop) ?? heldArgsContext(prop);
}

/** Whether `call`'s callee is `<chain>.<method>` with `key` an update-object key of `method`. */
function isDataCall(call: TS.CallExpression, key: string): boolean {
  const callee = skipParens(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.name) &&
    DATA_WRITE_KEYS.get(callee.name.text)?.includes(key) === true
  );
}

/**
 * An update call's whole argument held in a local variable first:
 * `const args = { where: { id }, data: { status: "paid" } }; await prisma.order.update(args)`.
 * The context is the call that takes the variable as its first argument; a `let`, several such
 * calls, other uses, or `args.data` / `args.where` set afterwards are `held.issue`s (as for an
 * update object held in a variable), so the write is reported instead of read.
 */
function heldArgsContext(prop: TS.PropertyAssignment):
  | {
      call: TS.CallExpression;
      args: TS.ObjectLiteralExpression;
      held: NonNullable<WriteNode["held"]>;
    }
  | undefined {
  const key = propertyName(prop);
  const args = prop.parent;
  if (key === undefined || !ts.isObjectLiteralExpression(args)) return undefined;
  const decl = heldDeclarationOf(args);
  if (!decl) return undefined;
  const name = (decl.name as TS.Identifier).text;
  const uses = heldUses(decl, new Set(["where", "data", "update"]));
  const calls = uses.args.filter((c) => {
    const first = c.arguments[0];
    const e = first && skipParens(unwrapArgument(first));
    return e !== undefined && ts.isIdentifier(e) && e.text === name && isDataCall(c, key);
  });
  const [call] = calls;
  if (!call) return undefined;
  const issues = [...uses.issues];
  if (calls.length > 1) issues.push(`\`${name}\` is the argument of ${calls.length} update calls`);
  for (const c of uses.args) {
    if (!calls.includes(c)) {
      issues.push(`\`${name}\` is also passed to \`${excerpt(c.expression.getText())}\``);
    }
  }
  for (const c of uses.data) {
    issues.push(`\`${name}\` is also used in \`${excerpt(c.expression.getText())}\``);
  }
  return { call, args, held: heldInfo(decl, issues) ?? { name } };
}

/**
 * The object literal an update call's first argument is: written into the call, or held in a
 * `const` declared before it in an enclosing block (`heldArgsContext`). Syntax only.
 */
export function updateArgsOf(call: TS.CallExpression): TS.ObjectLiteralExpression | undefined {
  const first = call.arguments[0];
  if (!first) return undefined;
  const a = stripValue(unwrapArgument(first) as TS.Expression);
  if (ts.isObjectLiteralExpression(a)) return a;
  return ts.isIdentifier(a) ? heldObjectNamed(call, a.text)?.object : undefined;
}

/**
 * The closest variable named `name` declared before `at` in an enclosing block of its function
 * (inline callbacks included), when an object literal initializes it. Syntax only.
 */
function heldObjectNamed(
  at: TS.Node,
  name: string,
): { decl: TS.VariableDeclaration; object: TS.ObjectLiteralExpression } | undefined {
  let child: TS.Node = at;
  for (let p: TS.Node | undefined = at.parent; p; child = p, p = p.parent) {
    if (ts.isFunctionLike(p) && !isInlineCallback(p)) return undefined;
    if (!ts.isBlock(p) && !ts.isSourceFile(p) && !ts.isCaseClause(p) && !ts.isDefaultClause(p)) {
      continue;
    }
    const statements: readonly TS.Statement[] = p.statements;
    for (let i = statements.indexOf(child as TS.Statement) - 1; i >= 0; i--) {
      const st = statements[i];
      if (!st || !ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
        const init = stripValue(unwrapArgument(d.initializer) as TS.Expression);
        return ts.isObjectLiteralExpression(init) ? { decl: d, object: init } : undefined;
      }
    }
  }
  return undefined;
}

/**
 * An assignment `data.<field> = v` to an object held in a local variable that the function then
 * uses as an update call's update object (`const data: Prisma.OrderUpdateInput = {};
 * data.status = "paid"; await prisma.order.update({ where: { id }, data })`): a `data` write of
 * that call whose object is built up before it, so always a `held.issue` (reported, not read).
 */
function matchFilledDataWrite(
  n: TS.BinaryExpression & { left: TS.PropertyAccessExpression },
  fields: ReadonlySet<string>,
): WriteNode | undefined {
  const target = skipParens(n.left.expression);
  if (!ts.isIdentifier(target)) return undefined;
  const held = heldObjectNamed(n, target.text);
  // An object that has the field already is a held `data` write itself (`matchHeldDataWrite`).
  if (!held || propertyNamed(held.object, n.left.name.text)) return undefined;
  const uses = heldUses(held.decl, fields);
  const [call] = uses.data;
  if (!call) return undefined;
  const issues = [...uses.issues];
  const set = `\`${target.text}.${n.left.name.text}\` is set after the object is built`;
  if (!issues.includes(set)) issues.unshift(set);
  return {
    kind: "data",
    field: n.left.name.text,
    expr: n,
    site: n,
    ref: n.left.expression,
    value: n.right,
    call,
    held: heldInfo(held.decl, issues) ?? { name: target.text },
  };
}

/**
 * The update call whose first argument has `prop` as its update object (`data` of `update`,
 * `update` of `upsert`), and that argument.
 */
function dataContextOf(
  prop: TS.PropertyAssignment | TS.ShorthandPropertyAssignment,
): { call: TS.CallExpression; args: TS.ObjectLiteralExpression } | undefined {
  const key = propertyName(prop);
  const args = prop.parent;
  if (key === undefined || !ts.isObjectLiteralExpression(args)) return undefined;
  const call = parentSkippingWrappers(args);
  if (!call || !ts.isCallExpression(call)) return undefined;
  const first = call.arguments[0];
  if (!first || unwrapArgument(first) !== args) return undefined;
  const callee = skipParens(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return undefined;
  if (!DATA_WRITE_KEYS.get(callee.name.text)?.includes(key)) return undefined;
  return { call, args };
}

/** The model segment of an ORM call: `order` in `prisma.order.update(…)`. */
export function modelOf(call: TS.CallExpression): string | undefined {
  const callee = skipParens(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const target = skipParens(callee.expression);
  if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.name)) return undefined;
  return target.name.text;
}

/** `X` in `where: { id: X.id }` (any key whose value is `X.<same key>`). */
function whereRef(args: TS.ObjectLiteralExpression): string | undefined {
  const where = propertyNamed(args, "where");
  if (!where || !ts.isPropertyAssignment(where)) return undefined;
  const w = skipParens(where.initializer);
  if (!ts.isObjectLiteralExpression(w)) return undefined;
  for (const p of w.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const v = stripValue(p.initializer);
    if (
      ts.isPropertyAccessExpression(v) &&
      !v.questionDotToken &&
      ts.isIdentifier(v.expression) &&
      v.name.text === propertyName(p)
    ) {
      return v.expression.text;
    }
  }
  return undefined;
}

/** Whether `init` is `await <chain>.<model>.find…(…)`. */
function isFindOn(init: TS.Expression, model: string): boolean {
  const e = stripValue(init);
  if (!ts.isCallExpression(e)) return false;
  const callee = skipParens(e.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    FIND_METHODS.has(callee.name.text) &&
    modelOf(e) === model
  );
}

/** The closest `const X = await <chain>.<model>.find…(…)` before `call` in an enclosing block. */
function precedingFind(call: TS.CallExpression, model: string): string | undefined {
  let child: TS.Node = call;
  for (let p: TS.Node | undefined = call.parent; p; child = p, p = p.parent) {
    if (!ts.isBlock(p) && !ts.isSourceFile(p) && !ts.isCaseClause(p) && !ts.isDefaultClause(p)) {
      continue;
    }
    const statements: readonly TS.Statement[] = p.statements;
    for (let i = statements.indexOf(child as TS.Statement) - 1; i >= 0; i--) {
      const st = statements[i];
      if (!st || !ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && isFindOn(d.initializer, model)) {
          return d.name.text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Callee texts in `sf` that may be a bound read function: each symbol (`getOrder`, `repo.get`)
 * and its last segment, a local alias of a named import of it (`import { getOrder as load }`),
 * and `ns.<symbol>` for a namespace import `ns`. Syntax only; phase 2 checks the symbol.
 */
function readNamesOf(sf: TS.SourceFile, symbols: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  const heads = new Set<string>();
  for (const s of symbols) {
    names.add(s);
    names.add(s.slice(s.lastIndexOf(".") + 1));
    heads.add(s.split(".")[0] as string);
  }
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const bindings = st.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      for (const s of symbols) names.add(`${bindings.name.text}.${s}`);
      continue;
    }
    for (const e of bindings.elements) {
      const imported = (e.propertyName ?? e.name).text;
      if (!heads.has(imported)) continue;
      for (const s of symbols) {
        const [head, ...rest] = s.split(".");
        if (head === imported) names.add([e.name.text, ...rest].join("."));
      }
    }
  }
  return names;
}

/** Whether `init` is `await? <name>(…)` for one of `names` (any call when `names` is undefined). */
function isReadCall(init: TS.Expression, names: ReadonlySet<string> | undefined): boolean {
  const e = stripValue(init);
  if (!ts.isCallExpression(e)) return false;
  if (!names) return true;
  const callee = referenceText(e.expression);
  return callee !== undefined && names.has(callee);
}

/** An arrow function or function expression passed directly as a call argument. */
function isInlineCallback(fn: TS.Node): boolean {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  return ts.isCallExpression(parentSkippingWrappers(fn));
}

/**
 * Phase 1: a `patch` (or `held`) write's probe reference: the closest `const X = await? <read>(…)`
 * before the call (or the declaration) in an enclosing block of its function (inline callbacks included), else the closest
 * `const X = await? <any call>(…)` (a read under a name phase 1 cannot see, such as a renamed
 * re-export). Phase 2 uses the probe only when `X` is typed as the entity.
 */
function patchRefText(at: TS.Node, names: ReadonlySet<string>): string | undefined {
  return closestConstCall(at, names) ?? closestConstCall(at, undefined);
}

function closestConstCall(at: TS.Node, names: ReadonlySet<string> | undefined): string | undefined {
  let child: TS.Node = at;
  for (let p: TS.Node | undefined = at.parent; p; child = p, p = p.parent) {
    if (ts.isFunctionLike(p) && !isInlineCallback(p)) return undefined;
    if (!ts.isBlock(p) && !ts.isSourceFile(p) && !ts.isCaseClause(p) && !ts.isDefaultClause(p)) {
      continue;
    }
    const statements: readonly TS.Statement[] = p.statements;
    for (let i = statements.indexOf(child as TS.Statement) - 1; i >= 0; i--) {
      const st = statements[i];
      if (!st || !ts.isVariableStatement(st)) continue;
      if (!(st.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && isReadCall(d.initializer, names)) {
          return d.name.text;
        }
      }
    }
  }
  return undefined;
}

/** Phase 1: the entity reference a `data` write's probe reads (see the module comment). */
function dataRefText(call: TS.CallExpression): string | undefined {
  const args = updateArgsOf(call);
  if (!args) return undefined;
  const model = modelOf(call);
  return whereRef(args) ?? (model === undefined ? undefined : precedingFind(call, model));
}

/** A `data` write: the update object of an ORM update call that sets one of `fields`. */
function matchDataWrite(
  n: TS.ObjectLiteralExpression,
  fields: ReadonlySet<string>,
): WriteNode | undefined {
  const context = dataContext(n);
  if (!context) return undefined;
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    const name = propertyName(p);
    if (name === undefined || !fields.has(name)) continue;
    // A shorthand's name is an identifier (TypeScript 7 types it as any property name).
    let value: TS.Expression = ts.isPropertyAssignment(p)
      ? p.initializer
      : (p.name as TS.Identifier);
    const inner = skipParens(value);
    if (ts.isObjectLiteralExpression(inner)) {
      const set = propertyNamed(inner, "set");
      if (set && ts.isPropertyAssignment(set)) value = set.initializer;
    }
    // In the probed program, `(ref.<field>, { … })` wraps the update object.
    const probe = probeRefOf(n);
    return {
      kind: "data",
      field: name,
      expr: n,
      site: p,
      ref: probe ?? n,
      value,
      call: context.call,
      probed: probe !== undefined,
      ...(context.held ? { held: context.held } : {}),
    };
  }
  return undefined;
}

/** The `(ref.<field>, W)` probe wrapping `n` in the probed program: its reference. */
function probeRefOf(n: TS.Expression): TS.Expression | undefined {
  const comma = n.parent;
  return ts.isBinaryExpression(comma) &&
    comma.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    comma.right === n &&
    ts.isPropertyAccessExpression(comma.left)
    ? comma.left.expression
    : undefined;
}

/**
 * The local variable an object literal initializes (`const patch = { … }`, also through `as`,
 * `satisfies` and parentheses, and the probe's `(ref.<field>, { … })` comma), if any.
 */
export function heldDeclarationOf(
  n: TS.ObjectLiteralExpression,
): TS.VariableDeclaration | undefined {
  let child: TS.Node = n;
  let p: TS.Node | undefined = n.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      isCommaRight(p, child) ||
      ((ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) && p.expression === child))
  ) {
    child = p;
    p = p.parent;
  }
  return p && ts.isVariableDeclaration(p) && p.initializer === child && ts.isIdentifier(p.name)
    ? p
    : undefined;
}

/** A `held` write: the state-field property of an object literal held in a local variable. */
function matchHeldWrite(
  n: TS.ObjectLiteralExpression,
  fields: ReadonlySet<string>,
): WriteNode | undefined {
  for (const p of n.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    const name = propertyName(p);
    if (name === undefined || !fields.has(name)) continue;
    const value = ts.isPropertyAssignment(p) ? p.initializer : (p.name as TS.Identifier);
    const probe = probeRefOf(n);
    return {
      kind: "held",
      field: name,
      expr: n,
      site: p,
      ref: probe ?? n,
      value,
      probed: probe !== undefined,
    };
  }
  return undefined;
}

/** The function (or file) a declaration's variable is visible in, for `heldUses`. */
function scopeOf(decl: TS.Node): TS.Node {
  for (let p: TS.Node | undefined = decl.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return p;
  }
  return decl.getSourceFile();
}

/** A node's source on one line (a call chain split over lines joined back), for a message. */
export function oneLine(node: TS.Node): string {
  return node
    .getText()
    .replace(/\s*\n\s*(?=\??\.)/g, "")
    .replace(/\s+/g, " ");
}

/** `text` on one line, cut to `max` characters, for a message. */
function excerpt(text: string, max = 40): string {
  const one = text.replace(/\s+/g, " ");
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** How a function uses a variable holding an object literal (`heldUses`). */
interface HeldUses {
  /** Update calls that take the variable as their update object (`data: x`, `{ data }`). */
  data: TS.CallExpression[];
  /** Calls that take the variable as an argument. */
  args: TS.CallExpression[];
  /** Why the object is not just built once and handed over; empty when it is. */
  issues: string[];
}

/**
 * Phase 1 (syntax only, so by name): the uses of the variable `decl` declares, in the function
 * (or file) that declares it. Reading or setting another field is fine; setting or deleting one
 * of `fields` afterwards, any other use, a `let`, or a second variable of that name in the same
 * function (which makes "by name" ambiguous) is an issue.
 */
function heldUses(decl: TS.VariableDeclaration, fields: ReadonlySet<string>): HeldUses {
  const name = (decl.name as TS.Identifier).text;
  const out: HeldUses = { data: [], args: [], issues: [] };
  const issue = (why: string) => {
    if (!out.issues.includes(why)) out.issues.push(why);
  };
  const usedIn = (node: TS.Node) =>
    issue(`\`${name}\` is also used in \`${excerpt(node.getText())}\``);
  if (!(decl.parent.flags & ts.NodeFlags.Const)) issue(`\`${name}\` is not a \`const\``);
  forEachDescendant(scopeOf(decl), (n) => {
    if (!ts.isIdentifier(n) || n.text !== name || n === decl.name) return;
    const parent = n.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === n) return;
    if (ts.isPropertyAssignment(parent) && parent.name === n) return;
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isFunctionDeclaration(parent)) &&
      parent.name === n
    ) {
      issue(`another \`${name}\` is declared in the same function`);
      return;
    }
    if (ts.isShorthandPropertyAssignment(parent)) {
      const context = dataContextOf(parent);
      if (context) out.data.push(context.call);
      else usedIn(parent.parent);
      return;
    }
    let use: TS.Node = n;
    while (
      ts.isParenthesizedExpression(use.parent) ||
      ts.isNonNullExpression(use.parent) ||
      ts.isAsExpression(use.parent) ||
      ts.isSatisfiesExpression(use.parent)
    ) {
      use = use.parent;
    }
    const p = use.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === use) {
      const context = dataContextOf(p);
      if (context) out.data.push(context.call);
      else usedIn(p.parent);
      return;
    }
    if (ts.isCallExpression(p) && p.arguments.some((a) => unwrapArgument(a) === use)) {
      out.args.push(p);
      return;
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === use) {
      const target = p.parent;
      const assigned =
        ts.isBinaryExpression(target) &&
        target.left === p &&
        target.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        target.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      if ((assigned || ts.isDeleteExpression(target)) && fields.has(p.name.text)) {
        issue(`\`${name}.${p.name.text}\` is set after the object is built`);
      }
      return; // reading a field, or setting another one
    }
    usedIn(p);
  });
  return out;
}

/** Whether a variable named `name` is declared after `decl`, in `decl`'s function. */
function declaredAfter(name: string, decl: TS.VariableDeclaration): boolean {
  let found = false;
  forEachDescendant(scopeOf(decl), (n) => {
    found ||=
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.getStart() > decl.getStart();
  });
  return found;
}

/** `held` of a write: the variable's name, and its issues joined, when there are any. */
function heldInfo(decl: TS.VariableDeclaration, issues: string[]): WriteNode["held"] {
  const name = (decl.name as TS.Identifier).text;
  return { name, ...(issues.length > 0 ? { issue: issues.join(", ") } : {}) };
}

/**
 * A `data` write held in a variable: an object literal with one of `fields`, held in `decl`,
 * that the function uses as an update call's update object (see the module comment).
 */
function matchHeldDataWrite(
  n: TS.ObjectLiteralExpression,
  decl: TS.VariableDeclaration,
  fields: ReadonlySet<string>,
): WriteNode | undefined {
  const prop = n.properties.find((p) => {
    const name = propertyName(p);
    return name !== undefined && fields.has(name);
  }) as TS.PropertyAssignment | TS.ShorthandPropertyAssignment | undefined;
  if (!prop) return undefined;
  const uses = heldUses(decl, fields);
  const [call] = uses.data;
  if (!call) return undefined;
  const name = (decl.name as TS.Identifier).text;
  const issues = [...uses.issues];
  if (uses.data.length > 1) {
    issues.push(`\`${name}\` is the update object of ${uses.data.length} calls`);
  }
  for (const c of uses.args) {
    issues.push(`\`${name}\` is also passed to \`${excerpt(c.expression.getText())}\``);
  }
  const ref = dataRefText(call);
  if (ref !== undefined && declaredAfter(ref, decl)) {
    issues.push(`\`${name}\` is built before \`${ref}\` is read`);
  }
  let value: TS.Expression = ts.isPropertyAssignment(prop)
    ? prop.initializer
    : (prop.name as TS.Identifier);
  const inner = skipParens(value);
  if (ts.isObjectLiteralExpression(inner)) {
    const set = propertyNamed(inner, "set");
    if (set && ts.isPropertyAssignment(set)) value = set.initializer;
  }
  const probe = probeRefOf(n);
  return {
    kind: "data",
    field: propertyName(prop) as string,
    expr: n,
    site: prop,
    ref: probe ?? n,
    value,
    call,
    probed: probe !== undefined,
    held: heldInfo(decl, issues),
  };
}

/**
 * A `spread` write held in a variable: `const next = { ...order, status: "paid" }`, which the
 * function passes to a call (see the module comment).
 */
function matchHeldSpreadWrite(
  n: TS.ObjectLiteralExpression,
  decl: TS.VariableDeclaration,
  fields: ReadonlySet<string>,
): WriteNode | undefined {
  let spread: TS.SpreadAssignment | undefined;
  let found: { p: TS.ObjectLiteralElementLike; name: string } | undefined;
  for (const p of n.properties) {
    if (ts.isSpreadAssignment(p)) {
      spread = p;
      continue;
    }
    const name = propertyName(p);
    if (spread && name !== undefined && fields.has(name)) {
      found = { p, name };
      break;
    }
  }
  if (!spread || !found) return undefined;
  const uses = heldUses(decl, fields);
  const [call] = uses.args;
  if (!call) return undefined;
  const name = (decl.name as TS.Identifier).text;
  const issues = [...uses.issues];
  if (uses.args.length > 1) issues.push(`\`${name}\` is passed to ${uses.args.length} calls`);
  const value = ts.isPropertyAssignment(found.p)
    ? found.p.initializer
    : ((found.p as TS.ShorthandPropertyAssignment).name as TS.Identifier);
  return {
    kind: "spread",
    field: found.name,
    expr: n,
    site: found.p,
    ref: spread.expression,
    value,
    call,
    held: heldInfo(decl, issues),
  };
}

/**
 * An assignment to a field of a fresh object the function builds before saving it: a copy
 * (`const next = { ...order }; next.status = "cancelled"`) or an empty patch filled afterwards
 * (`const patch: Partial<Order> = {}; patch.status = "cancelled"`). The state is not set on
 * the entity a read returned, so the write can't be read as a transition: `held.issue` (reported
 * as `unanalyzable`), with the call that takes the object, if any. (Named storage functions
 * handle such objects themselves, `adapters/functions.ts`.)
 */
function builtUp(n: TS.BinaryExpression & { left: TS.PropertyAccessExpression }): {
  held?: NonNullable<WriteNode["held"]>;
  call?: TS.CallExpression;
} {
  const target = skipParens(n.left.expression);
  if (!ts.isIdentifier(target)) return {};
  const held = heldObjectNamed(n, target.text);
  if (!held) return {};
  const { properties } = held.object;
  if (properties.length > 0 && !properties.some((p) => ts.isSpreadAssignment(p))) return {};
  const uses = heldUses(held.decl, new Set([n.left.name.text]));
  const set = `\`${target.text}.${n.left.name.text}\` is set after the object is built`;
  const issues = uses.issues.includes(set) ? uses.issues : [set, ...uses.issues];
  const [call] = uses.args;
  return {
    held: heldInfo(held.decl, issues) ?? { name: target.text },
    ...(call ? { call } : {}),
  };
}

/** Matches one node; shared by both phases so they find identical writes in identical order. */
function matchWrite(
  n: TS.Node,
  fields: ReadonlySet<string>,
  patch: PatchOptions | undefined,
): WriteNode | undefined {
  if (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(n.left) &&
    ts.isIdentifier(n.left.name) &&
    fields.has(n.left.name.text) &&
    !isConstructorInit(n.left)
  ) {
    const filled = matchFilledDataWrite(
      n as TS.BinaryExpression & { left: TS.PropertyAccessExpression },
      fields,
    );
    if (filled) return filled;
    return {
      kind: "assign",
      field: n.left.name.text,
      expr: n,
      site: n,
      ref: n.left.expression,
      value: n.right,
      ...(patch ? {} : builtUp(n as TS.BinaryExpression & { left: TS.PropertyAccessExpression })),
    };
  }
  if (ts.isObjectLiteralExpression(n)) {
    const parent = parentSkippingWrappers(n);
    if (parent && ts.isPropertyAssignment(parent)) return matchDataWrite(n, fields);
    const held = heldDeclarationOf(n);
    if (held) {
      return (
        matchHeldDataWrite(n, held, fields) ??
        (patch ? matchHeldWrite(n, patch.fields) : matchHeldSpreadWrite(n, held, fields))
      );
    }
    if (!parent || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return undefined;
    if (!parent.arguments?.some((a) => unwrapArgument(a) === n)) return undefined;
    let spread: TS.SpreadAssignment | undefined;
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) {
        spread = p;
        continue;
      }
      const name = propertyName(p);
      if (name === undefined) continue;
      const value = ts.isPropertyAssignment(p)
        ? p.initializer
        : ((p as TS.ShorthandPropertyAssignment).name as TS.Identifier);
      if (spread) {
        if (!fields.has(name)) continue;
        return { kind: "spread", field: name, expr: n, site: p, ref: spread.expression, value };
      }
      if (patch?.fields.has(name) && ts.isCallExpression(parent)) {
        const probe = probeRefOf(n);
        return {
          kind: "patch",
          field: name,
          expr: n,
          site: p,
          ref: probe ?? n,
          value,
          call: parent,
          probed: probe !== undefined,
        };
      }
    }
  }
  return undefined;
}

function findWrites(
  sf: TS.SourceFile,
  fields: ReadonlySet<string>,
  patch: PatchOptions | undefined,
): WriteNode[] {
  const out: WriteNode[] = [];
  forEachDescendant(sf, (n) => {
    const w = matchWrite(n, fields, patch);
    if (w) out.push(w);
  });
  return out;
}

/** Phase 1, syntax only: candidate writes of any of `fields` in the original files. */
export function findCandidateWrites(
  files: readonly TS.SourceFile[],
  fields: ReadonlySet<string>,
  patch?: PatchOptions,
): CandidateWrite[] {
  const out: CandidateWrite[] = [];
  for (const sf of files) {
    let readNames: ReadonlySet<string> | undefined;
    for (const w of findWrites(sf, fields, patch)) {
      let ref: string | undefined;
      if (w.kind === "patch" && w.call) {
        readNames ??= readNamesOf(sf, patch?.readSymbols ?? []);
        ref = patchRefText(w.call, readNames);
      } else if (w.kind === "held") {
        readNames ??= readNamesOf(sf, patch?.readSymbols ?? []);
        const decl = heldDeclarationOf(w.expr as TS.ObjectLiteralExpression);
        ref = decl && patchRefText(decl, readNames);
      } else if (w.kind === "data" && w.call) {
        ref = dataRefText(w.call);
        // With named storage functions, an ORM update is a patch to an unbound call: its
        // reference may also be what a bound read returned.
        if (ref === undefined && patch) {
          readNames ??= readNamesOf(sf, patch.readSymbols);
          ref = patchRefText(w.call, readNames);
        }
      } else ref = referenceText(w.ref);
      out.push({
        kind: w.kind,
        field: w.field,
        file: sf.fileName,
        span: { start: w.expr.getStart(sf), end: w.expr.getEnd() },
        ...(ref === undefined ? {} : { ref }),
      });
    }
  }
  return out;
}

/**
 * Phase 2: the same writes in the probed program, index-aligned with `candidates`. Probes add
 * reads, never writes, so a file's writes are found in the same order. `toOriginal` verifies it.
 */
export function rebindWrites(
  candidates: readonly CandidateWrite[],
  fields: ReadonlySet<string>,
  sourceFile: (file: string) => TS.SourceFile | undefined,
  toOriginal: (file: string, offset: number) => number,
  patch?: PatchOptions,
): WriteNode[] {
  const perFile = new Map<string, WriteNode[]>();
  const cursor = new Map<string, number>();
  return candidates.map((c) => {
    let writes = perFile.get(c.file);
    if (!writes) {
      const sf = sourceFile(c.file);
      if (!sf) throw new Error(`extractor: ${c.file} missing from the probed program`);
      writes = findWrites(sf, fields, patch);
      perFile.set(c.file, writes);
    }
    const i = cursor.get(c.file) ?? 0;
    cursor.set(c.file, i + 1);
    const w = writes[i];
    const sf = w?.expr.getSourceFile();
    if (!w || !sf || toOriginal(c.file, w.expr.getStart(sf)) !== c.span.start) {
      throw new Error(`extractor: probed write ${i} in ${c.file} does not line up`);
    }
    return w;
  });
}
