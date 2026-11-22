/**
 * State-write discovery. Phase 1 (`findCandidateWrites`) is purely syntactic so every probe can be
 * planned before the first type query; phase 2 (`rebindWrites`) re-finds the same writes in the
 * probed program, where all later analysis happens.
 *
 * A candidate write is
 * - an assignment `x.<field> = v` (plain `=` only), or
 * - an object literal `{ ...x, <field>: v }` passed directly as a call argument
 *   (`db.orders.save({ ...order, status: "refunded" })`); `x` is the last spread before the field.
 *
 * Not candidates: `this.<field> = v` in a constructor (object initialization, not a transition).
 *
 * Whether a candidate belongs to a spec's entity is decided later, with types (`entity.ts`).
 */
import { ts } from "ts-morph";

export type WriteKind = "assign" | "spread";

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
  expr: ts.Expression;
  /** The reported write site: the assignment, or the `field: v` property. */
  site: ts.Node;
  /** The entity reference: assignment target object, or the spread expression. */
  ref: ts.Expression;
  /** The written value expression (`undefined` for a shorthand property: its identifier). */
  value: ts.Expression;
}

function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void): void {
  ts.forEachChild(node, (c) => {
    visit(c);
    forEachDescendant(c, visit);
  });
}

function skipParens(n: ts.Node): ts.Node {
  let cur = n;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function isCommaRight(p: ts.Node, child: ts.Node): boolean {
  return (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    p.right === child
  );
}

/** Parent, skipping parentheses and the `(probe, W)` comma a probe wraps `W` in. */
export function parentSkippingWrappers(n: ts.Node): ts.Node {
  let child = n;
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || isCommaRight(p, child))) {
    child = p;
    p = p.parent;
  }
  return p;
}

/** Strips parentheses and `(probe, W)` commas from an argument. */
export function unwrapArgument(a: ts.Node): ts.Node {
  let cur = a;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      cur = cur.right;
    } else return cur;
  }
}

/** `a`, `this`, `a.b.c` → canonical text; anything else (calls, element access, `?.`) → undefined. */
export function referenceText(expr: ts.Expression): string | undefined {
  const e = skipParens(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.name)) {
    const inner = referenceText(e.expression);
    return inner === undefined ? undefined : `${inner}.${e.name.text}`;
  }
  return undefined;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return undefined;
  const name = p.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** `this.<field> = v` directly in a constructor body initializes a new object: not a transition. */
function isConstructorInit(target: ts.PropertyAccessExpression): boolean {
  if (target.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  for (let p: ts.Node | undefined = target.parent; p; p = p.parent) {
    if (ts.isConstructorDeclaration(p)) return true;
    if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) return false;
  }
  return false;
}

/** Matches one node; shared by both phases so they find identical writes in identical order. */
function matchWrite(n: ts.Node, fields: ReadonlySet<string>): WriteNode | undefined {
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
    if (!parent || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return undefined;
    if (!parent.arguments?.some((a) => unwrapArgument(a) === n)) return undefined;
    let spread: ts.SpreadAssignment | undefined;
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) {
        spread = p;
        continue;
      }
      const name = propertyName(p);
      if (name === undefined || !fields.has(name) || !spread) continue;
      const value = ts.isPropertyAssignment(p)
        ? p.initializer
        : (p as ts.ShorthandPropertyAssignment).name;
      return { kind: "spread", field: name, expr: n, site: p, ref: spread.expression, value };
    }
  }
  return undefined;
}

function findWrites(sf: ts.SourceFile, fields: ReadonlySet<string>): WriteNode[] {
  const out: WriteNode[] = [];
  forEachDescendant(sf, (n) => {
    const w = matchWrite(n, fields);
    if (w) out.push(w);
  });
  return out;
}

/** Phase 1, syntax only: candidate writes of any of `fields` in the original files. */
export function findCandidateWrites(
  files: readonly ts.SourceFile[],
  fields: ReadonlySet<string>,
): CandidateWrite[] {
  const out: CandidateWrite[] = [];
  for (const sf of files) {
    for (const w of findWrites(sf, fields)) {
      out.push({
        kind: w.kind,
        field: w.field,
        file: sf.fileName,
        span: { start: w.expr.getStart(sf), end: w.expr.getEnd() },
        ref: referenceText(w.ref),
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
  sourceFile: (file: string) => ts.SourceFile | undefined,
  toOriginal: (file: string, offset: number) => number,
): WriteNode[] {
  const perFile = new Map<string, WriteNode[]>();
  const cursor = new Map<string, number>();
  return candidates.map((c) => {
    let writes = perFile.get(c.file);
    if (!writes) {
      const sf = sourceFile(c.file);
      if (!sf) throw new Error(`extractor: ${c.file} missing from the probed program`);
      writes = findWrites(sf, fields);
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
