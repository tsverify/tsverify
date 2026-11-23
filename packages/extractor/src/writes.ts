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

export type WriteKind = "assign" | "spread" | "data" | "patch" | "update";

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
  /** `data` / `patch` writes: whether `ref` is the probe's reference (else it is the object). */
  probed?: boolean;
  /** `update` writes with a fixed target (`to:` in the binding): the written state. */
  fixedValue?: string;
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

/** `data`-write context of an object literal: the update call and its first argument. */
function dataContext(
  n: TS.ObjectLiteralExpression,
): { call: TS.CallExpression; args: TS.ObjectLiteralExpression } | undefined {
  const prop = parentSkippingWrappers(n);
  if (!prop || !ts.isPropertyAssignment(prop) || unwrapArgument(prop.initializer) !== n) {
    return undefined;
  }
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

/** Whether `init` is `await? <name>(…)` for one of `names`. */
function isReadCall(init: TS.Expression, names: ReadonlySet<string>): boolean {
  const e = stripValue(init);
  if (!ts.isCallExpression(e)) return false;
  const callee = referenceText(e.expression);
  return callee !== undefined && names.has(callee);
}

/** An arrow function or function expression passed directly as a call argument. */
function isInlineCallback(fn: TS.Node): boolean {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  return ts.isCallExpression(parentSkippingWrappers(fn));
}

/**
 * Phase 1: a `patch` write's probe reference: the closest `const X = await? <read>(…)` before
 * the call in an enclosing block of its function (inline callbacks included).
 */
function patchRefText(call: TS.CallExpression, names: ReadonlySet<string>): string | undefined {
  let child: TS.Node = call;
  for (let p: TS.Node | undefined = call.parent; p; child = p, p = p.parent) {
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
  const args = unwrapArgument(call.arguments[0] as TS.Node);
  if (!ts.isObjectLiteralExpression(args)) return undefined;
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
    return {
      kind: "assign",
      field: n.left.name.text,
      expr: n,
      site: n,
      ref: n.left.expression,
      value: n.right,
    };
  }
  if (ts.isObjectLiteralExpression(n)) {
    const parent = parentSkippingWrappers(n);
    if (parent && ts.isPropertyAssignment(parent)) return matchDataWrite(n, fields);
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
      } else ref = w.call ? dataRefText(w.call) : referenceText(w.ref);
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
