/**
 * A call's result held in a `let` (or `var`) that each branch assigns and one test reads
 * afterwards, as a conditional save's often is:
 *
 * ```ts
 * let updated: Order | undefined;
 * switch (input.status) {
 *   case "paid": updated = await setOrderStatusIf(tx, id, "pending", "paid"); break;
 *   case "refunded": updated = await setOrderStatusIf(tx, id, "paid", "refunded"); break;
 *   default: throw new Error("bad status");
 * }
 * if (!updated) throw new ConflictError("changed concurrently");
 * ```
 *
 * A read of such a variable is a read of one call's result (`holdsResultOf`) when, over the CFG
 * of its frame:
 * - every assignment to it is its declaration (`let v = …`, `let v;`: `undefined`) or a plain
 *   `v = …` in the function that declares it: no `+=`, `++`, destructuring or `for (v of …)`,
 *   and no write from a nested function;
 * - no path reaches the read before an assignment. A `switch` without `default` on a literal
 *   union, with a case for each member, has no path past its cases;
 * - every assignment that can reach the read assigns the call, or another call `accepts` takes
 *   (another conditional save);
 * - one of them assigns the call, and no path from it to the read passes another assignment or
 *   the call again (a retry loop, whose earlier attempts the read doesn't see).
 *
 * Anything else is not the call's result: the read is then not a test of it.
 */
import { frameOf } from "./callgraph";
import { buildCfg, type Cfg, ENTRY, isFunctionLike, reachable } from "./cfg";
import { declarationsOf, valueDeclarationOf } from "./declarations";
import { symbolOf } from "./resolve";
import type * as TS from "./ts-types";
import { literalsOf } from "./type-facts";
import { ts } from "./typescript";

interface Assignment {
  /** The value assigned; none for a `let v;`. */
  rhs: TS.Expression | undefined;
  /** The assignment's CFG nodes (after its right-hand side is evaluated). */
  ids: readonly number[];
}

interface ReadFacts {
  cfg: Cfg;
  read: readonly number[];
  assignments: readonly Assignment[];
  /** The assignments whose value the read can see. */
  reaching: readonly Assignment[];
}

const memo = new WeakMap<TS.Node, ReadFacts | null>();

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

function enclosingFunction(n: TS.Node): TS.Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return undefined;
}

function isAssignmentOperator(kind: TS.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * How a reference to the variable uses it: a read, a plain assignment `v = …` (the binary
 * expression), or any other write (`v += …`, `v++`, `[v] = …`, `for (v of …)`).
 */
function useOf(id: TS.Identifier): "read" | TS.BinaryExpression | "other" {
  let n: TS.Node = id;
  let p = n.parent;
  while (p && ts.isParenthesizedExpression(p)) {
    n = p;
    p = p.parent;
  }
  if (!p) return "read";
  if (ts.isBinaryExpression(p) && p.left === n && isAssignmentOperator(p.operatorToken.kind)) {
    const inPattern =
      ts.isArrayLiteralExpression(p.parent) ||
      ts.isPropertyAssignment(p.parent) ||
      ts.isSpreadElement(p.parent);
    if (p.operatorToken.kind === ts.SyntaxKind.EqualsToken && !inPattern) return p;
    return "other";
  }
  if (
    (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return "other";
  }
  // A destructuring target: `[v] = …`, `({ v } = …)`, `({ x: v } = …)`, `for ([v] of …)`.
  let pattern = false;
  for (;;) {
    if (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)) pattern = true;
    else if (
      !ts.isParenthesizedExpression(p) &&
      !ts.isSpreadElement(p) &&
      !ts.isSpreadAssignment(p) &&
      !ts.isShorthandPropertyAssignment(p) &&
      !(ts.isPropertyAssignment(p) && p.initializer === n)
    ) {
      break;
    }
    n = p;
    p = p.parent;
    if (!p) return "read";
  }
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n) return "other";
  if (
    pattern &&
    ts.isBinaryExpression(p) &&
    p.left === n &&
    isAssignmentOperator(p.operatorToken.kind)
  ) {
    return "other";
  }
  return "read";
}

/**
 * Whether a `switch` without `default` has a case for every value of its expression's type: a
 * union of string, number or boolean literals (and not `undefined` or `null`).
 */
function coversEveryValue(s: TS.SwitchStatement, checker: TS.Checker): boolean {
  const type = checker.getTypeAtLocation(s.expression);
  if (!type) return false;
  const F = ts.TypeFlags;
  const parts = type.isUnionType() ? type.getTypes() : [type];
  if (parts.some((p) => p.flags & (F.Undefined | F.Null | F.Void))) return false;
  const values = literalsOf(type, checker);
  if (values === "*" || values.length === 0) return false;
  const cases = new Set<string>();
  for (const clause of s.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    const v = literalsOf(checker.getTypeAtLocation(clause.expression), checker);
    if (v !== "*" && v.length === 1) cases.add(v[0] as string);
  }
  return values.every((v) => cases.has(v));
}

function readFacts(use: TS.Identifier, checker: TS.Checker): ReadFacts | undefined {
  const sym = symbolOf(use, checker);
  const decl = valueDeclarationOf(sym);
  if (!sym || !decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return;
  const scoped = decl.parent.flags & ts.NodeFlags.BlockScoped;
  if (scoped !== 0 && scoped !== ts.NodeFlags.Let) return; // a `const` or `using`
  const owner = enclosingFunction(decl);
  const frame = frameOf(decl);
  if (!owner || !frame || enclosingFunction(use) !== owner) return;
  const name = decl.name;

  // The declarations that set it: a `let` (to its initializer, or `undefined`) each time it
  // runs; a `var` where it has an initializer (a lone `var v;` sets nothing).
  const setters: TS.VariableDeclaration[] = [];
  for (const d of declarationsOf(sym)) {
    if (!ts.isVariableDeclaration(d)) return;
    const list = d.parent;
    if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(list.parent)) return;
    if (enclosingFunction(d) !== owner) return;
    if (scoped !== 0 || d.initializer !== undefined) setters.push(d);
  }
  const binaries: TS.BinaryExpression[] = [];
  let other = false;
  const visit = (n: TS.Node): void => {
    if (other) return;
    if (ts.isIdentifier(n) && n !== name && n.text === name.text) {
      if (symbolOf(n, checker) === sym && !ts.isVariableDeclaration(n.parent)) {
        const u = useOf(n);
        if (u === "other" || (u !== "read" && enclosingFunction(u) !== owner)) other = true;
        else if (u !== "read") binaries.push(u);
      }
    }
    n.forEachChild(visit);
  };
  owner.forEachChild(visit);
  if (other) return;

  const picked = new Set<TS.Node>([use, ...setters]);
  const cfg = buildCfg(frame, {
    nodesOf: (n) => picked.has(n),
    exhaustive: (s) => coversEveryValue(s, checker),
  });
  const read = cfg.idsOf(use);
  if (read.length === 0) return;
  const assignments: Assignment[] = [
    ...setters.map((d) => ({ rhs: d.initializer, ids: cfg.idsOf(d) })),
    ...binaries.map((b) => ({ rhs: b.right, ids: cfg.idsOf(b) })),
  ];
  if (assignments.some((a) => a.ids.length === 0)) return;
  const killed = new Set(assignments.flatMap((a) => a.ids));
  const reaches = (from: readonly number[], blocked: ReadonlySet<number>) => {
    const seen = reachable(cfg, from, blocked);
    return read.some((id) => seen[id] === 1);
  };
  // Some path reads the variable before anything set it.
  if (reaches([ENTRY], killed)) return;
  const reaching = assignments.filter((a) => reaches(a.ids, killed));
  return { cfg, read, assignments, reaching };
}

/**
 * Whether `use`, a read of a `let` or `var`, sees the result of `call` there, and otherwise only
 * results of calls `accepts` takes (see the module comment). A `const` is not read here.
 */
export function holdsResultOf(
  use: TS.Expression,
  call: TS.CallExpression,
  accepts: (other: TS.CallExpression) => boolean,
  checker: TS.Checker,
): boolean {
  if (!ts.isIdentifier(use)) return false;
  let facts = memo.get(use);
  if (facts === undefined) {
    facts = readFacts(use, checker) ?? null;
    memo.set(use, facts);
  }
  if (!facts || facts.reaching.length === 0) return false;
  const callOf = (a: Assignment) => {
    const r = a.rhs && strip(a.rhs);
    return r && ts.isCallExpression(r) ? r : undefined;
  };
  for (const a of facts.reaching) {
    const c = callOf(a);
    if (!c || (c !== call && !accepts(c))) return false;
  }
  const mine = facts.reaching.filter((a) => callOf(a) === call).flatMap((a) => a.ids);
  if (mine.length === 0) return false;
  const { cfg, read } = facts;
  // The call again before the read: a retry loop, whose earlier failures the read doesn't see.
  const beforeRead = reachable(cfg, mine, new Set(read));
  if (cfg.idsOf(call).some((id) => beforeRead[id] === 1)) return false;
  // Another assignment between this one and the read.
  const fromMine = reachable(cfg, mine);
  const between = facts.assignments
    .filter((a) => callOf(a) !== call)
    .flatMap((a) => a.ids)
    .filter((id) => fromMine[id] === 1);
  if (between.length === 0) return true;
  const after = reachable(cfg, between, new Set(mine));
  return !read.some((id) => after[id] === 1);
}
