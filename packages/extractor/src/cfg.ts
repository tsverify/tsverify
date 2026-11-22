/**
 * Control-flow graph of one function body, at the granularity dominance and suspension analysis
 * need: one node per call (after its callee and arguments are evaluated), per plain assignment,
 * per object literal and per suspension point (`await` / `yield` after their operand; a
 * `for await` loop's statement at every iteration's step), plus synthetic join nodes.
 * Expressions are visited in evaluation order.
 *
 * Modelled: `if`, `?:`, `&&` / `||` / `??` (and their assignment forms), optional calls, loops
 * with `break` / `continue` (labels too), `switch` with fall-through, `return`, `throw`,
 * `try` / `catch` / `finally`. Any call may throw: the frontier *before* the call (the call
 * started but did not complete) flows to the current throw target, so a throwing guard inside a
 * `try` does not count as passed on the way to the `catch`.
 *
 * **Inline callbacks** (a function expression passed directly as a call argument, e.g.
 * `db.transaction(async (tx) => …)`) are built in place: after the arguments, before the call
 * node, executed zero or one time. Their `return` ends the callback, not the function. Other
 * nested functions are separate frames (see `callgraph.ts`).
 *
 * Not modelled (over-approximations): truthiness of conditions (both branches are always
 * possible), `return` inside `try` skipping `finally`, generator resumption (a `yield` is only a
 * suspension point). An `await` adds no throw edge of its own: the awaited call's edge covers a
 * rejection.
 */
import { ts } from "ts-morph";

export type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

export function isFunctionLike(n: ts.Node): n is FunctionLike {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n)
  );
}

/** A function expression passed directly (through parentheses) as a call or `new` argument. */
export function inlineCallbackCall(fn: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  let child: ts.Node = fn;
  let p = fn.parent;
  while (p && ts.isParenthesizedExpression(p)) {
    child = p;
    p = p.parent;
  }
  if (
    p &&
    (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
    p.arguments?.includes(child as ts.Expression)
  ) {
    return p;
  }
  return undefined;
}

function stripParens(n: ts.Expression): ts.Expression {
  let cur = n;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

export const ENTRY = 0;
export const EXIT = 1;
export const THROW_EXIT = 2;

export interface Cfg {
  /** The ts node of each CFG node; `undefined` for entry, exits and joins. */
  readonly nodes: readonly (ts.Node | undefined)[];
  readonly succ: readonly (readonly number[])[];
  /** CFG nodes of a ts node (more than one when a `finally` block is built twice). */
  idsOf(node: ts.Node): readonly number[];
}

type Frontier = number[];

interface JumpContext {
  labels: string[];
  breakTo: number;
  continueTo?: number;
}

class Builder {
  readonly nodes: (ts.Node | undefined)[] = [undefined, undefined, undefined];
  readonly succ: number[][] = [[], [], []];
  readonly ids = new Map<ts.Node, number[]>();
  private returnTo = EXIT;
  private throwTo = THROW_EXIT;
  private jumps: JumpContext[] = [];
  private pendingLabels: string[] = [];

  private add(n: ts.Node | undefined): number {
    const id = this.nodes.length;
    this.nodes.push(n);
    this.succ.push([]);
    if (n) {
      const list = this.ids.get(n);
      if (list) list.push(id);
      else this.ids.set(n, [id]);
    }
    return id;
  }

  private connect(from: Frontier, to: number): void {
    for (const f of from) {
      const s = this.succ[f] as number[];
      if (!s.includes(to)) s.push(to);
    }
  }

  private node(n: ts.Node, f: Frontier): Frontier {
    const id = this.add(n);
    this.connect(f, id);
    return [id];
  }

  private join(): number {
    return this.add(undefined);
  }

  build(fn: FunctionLike): Cfg {
    const body = fn.body;
    let out: Frontier = [ENTRY];
    if (body) out = ts.isBlock(body) ? this.stmt(body, out) : this.expr(body, out);
    this.connect(out, EXIT);
    const ids = this.ids;
    return { nodes: this.nodes, succ: this.succ, idsOf: (n) => ids.get(n) ?? [] };
  }

  private inline(fn: ts.ArrowFunction | ts.FunctionExpression, f: Frontier): Frontier {
    const saved = { returnTo: this.returnTo, jumps: this.jumps, labels: this.pendingLabels };
    const ret = this.join();
    this.returnTo = ret;
    this.jumps = [];
    this.pendingLabels = [];
    const out = ts.isBlock(fn.body) ? this.stmt(fn.body, f) : this.expr(fn.body, f);
    this.connect(out, ret);
    this.returnTo = saved.returnTo;
    this.jumps = saved.jumps;
    this.pendingLabels = saved.labels;
    return [ret];
  }

  private takeLabels(): string[] {
    const l = this.pendingLabels;
    this.pendingLabels = [];
    return l;
  }

  private loop(
    labels: string[],
    continueTo: number,
    body: ts.Statement,
    f: Frontier,
  ): { out: Frontier; breakTo: number } {
    const breakTo = this.join();
    this.jumps.push({ labels, breakTo, continueTo });
    const out = this.stmt(body, f);
    this.jumps.pop();
    return { out, breakTo };
  }

  private stmt(s: ts.Statement, f: Frontier): Frontier {
    if (ts.isBlock(s)) {
      let cur = f;
      for (const st of s.statements) cur = this.stmt(st, cur);
      return cur;
    }
    if (ts.isExpressionStatement(s)) return this.expr(s.expression, f);
    if (ts.isVariableStatement(s)) return this.varList(s.declarationList, f);
    if (ts.isIfStatement(s)) {
      const c = this.expr(s.expression, f);
      const t = this.stmt(s.thenStatement, c);
      const e = s.elseStatement ? this.stmt(s.elseStatement, c) : c;
      return [...t, ...e];
    }
    if (ts.isReturnStatement(s)) {
      this.connect(this.expr(s.expression, f), this.returnTo);
      return [];
    }
    if (ts.isThrowStatement(s)) {
      this.connect(this.expr(s.expression, f), this.throwTo);
      return [];
    }
    if (ts.isTryStatement(s)) return this.tryStmt(s, f);
    if (ts.isWhileStatement(s)) {
      const labels = this.takeLabels();
      const head = this.join();
      this.connect(f, head);
      const c = this.expr(s.expression, [head]);
      const { out, breakTo } = this.loop(labels, head, s.statement, c);
      this.connect(out, head);
      return [...c, breakTo];
    }
    if (ts.isDoStatement(s)) {
      const labels = this.takeLabels();
      const head = this.join();
      const cont = this.join();
      this.connect(f, head);
      const { out, breakTo } = this.loop(labels, cont, s.statement, [head]);
      this.connect(out, cont);
      const c = this.expr(s.expression, [cont]);
      this.connect(c, head);
      return [...c, breakTo];
    }
    if (ts.isForStatement(s)) {
      const labels = this.takeLabels();
      let cur = f;
      const init = s.initializer;
      if (init)
        cur = ts.isVariableDeclarationList(init) ? this.varList(init, cur) : this.expr(init, cur);
      const head = this.join();
      this.connect(cur, head);
      const c = s.condition ? this.expr(s.condition, [head]) : [head];
      const cont = this.join();
      const { out, breakTo } = this.loop(labels, cont, s.statement, c);
      this.connect(out, cont);
      this.connect(this.expr(s.incrementor, [cont]), head);
      return s.condition ? [...c, breakTo] : [breakTo];
    }
    if (ts.isForOfStatement(s) || ts.isForInStatement(s)) {
      const labels = this.takeLabels();
      const e = this.expr(s.expression, f);
      const head = this.join();
      this.connect(e, head);
      // `for await`: every step (including the one that finds the end) awaits `next()`.
      const step = ts.isForOfStatement(s) && s.awaitModifier ? this.node(s, [head]) : [head];
      const { out, breakTo } = this.loop(labels, head, s.statement, step);
      this.connect(out, head);
      return [...step, breakTo];
    }
    if (ts.isSwitchStatement(s)) {
      const labels = this.takeLabels();
      const e = this.expr(s.expression, f);
      const breakTo = this.join();
      this.jumps.push({ labels, breakTo });
      let fall: Frontier = [];
      let hasDefault = false;
      for (const clause of s.caseBlock.clauses) {
        let entry: Frontier;
        if (ts.isCaseClause(clause)) entry = this.expr(clause.expression, e);
        else {
          hasDefault = true;
          entry = e;
        }
        let cur: Frontier = [...entry, ...fall];
        for (const st of clause.statements) cur = this.stmt(st, cur);
        fall = cur;
      }
      this.jumps.pop();
      return [...fall, breakTo, ...(hasDefault ? [] : e)];
    }
    if (ts.isLabeledStatement(s)) {
      const inner = s.statement;
      const isLoopOrSwitch = ts.isIterationStatement(inner, false) || ts.isSwitchStatement(inner);
      if (isLoopOrSwitch) {
        this.pendingLabels = [...this.pendingLabels, s.label.text];
        return this.stmt(inner, f);
      }
      const breakTo = this.join();
      this.jumps.push({ labels: [s.label.text], breakTo });
      const out = this.stmt(inner, f);
      this.jumps.pop();
      return [...out, breakTo];
    }
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) {
      const label = s.label?.text;
      const isBreak = ts.isBreakStatement(s);
      for (let i = this.jumps.length - 1; i >= 0; i--) {
        const j = this.jumps[i] as JumpContext;
        if (label !== undefined && !j.labels.includes(label)) continue;
        if (isBreak) {
          this.connect(f, j.breakTo);
          return [];
        }
        if (j.continueTo !== undefined) {
          this.connect(f, j.continueTo);
          return [];
        }
      }
      return [];
    }
    // Declarations (functions, classes, types, imports) and empty statements don't execute code.
    return f;
  }

  private varList(list: ts.VariableDeclarationList, f: Frontier): Frontier {
    let cur = f;
    for (const d of list.declarations) cur = this.expr(d.initializer, cur);
    return cur;
  }

  private tryStmt(s: ts.TryStatement, f: Frontier): Frontier {
    const outerThrow = this.throwTo;
    const tryThrow = this.join();
    this.throwTo = tryThrow;
    const tryOut = this.stmt(s.tryBlock, f);
    this.throwTo = outerThrow;
    let out = tryOut;
    let uncaught: number | undefined = tryThrow;
    if (s.catchClause) {
      const catchThrow = s.finallyBlock ? this.join() : outerThrow;
      this.throwTo = catchThrow;
      const catchOut = this.stmt(s.catchClause.block, [tryThrow]);
      this.throwTo = outerThrow;
      out = [...tryOut, ...catchOut];
      uncaught = s.finallyBlock ? catchThrow : undefined;
    }
    if (!s.finallyBlock) return out;
    const normal = this.stmt(s.finallyBlock, out);
    if (uncaught !== undefined) this.connect(this.stmt(s.finallyBlock, [uncaught]), outerThrow);
    return normal;
  }

  private expr(e: ts.Node | undefined, f: Frontier): Frontier {
    if (!e) return f;
    if (isFunctionLike(e) || ts.isClassLike(e)) return f;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      const K = ts.SyntaxKind;
      if (
        op === K.AmpersandAmpersandToken ||
        op === K.BarBarToken ||
        op === K.QuestionQuestionToken ||
        op === K.AmpersandAmpersandEqualsToken ||
        op === K.BarBarEqualsToken ||
        op === K.QuestionQuestionEqualsToken
      ) {
        const l = this.expr(e.left, f);
        return [...l, ...this.expr(e.right, l)];
      }
      const r = this.expr(e.right, this.expr(e.left, f));
      return op === K.EqualsToken ? this.node(e, r) : r;
    }
    if (ts.isConditionalExpression(e)) {
      const c = this.expr(e.condition, f);
      return [...this.expr(e.whenTrue, c), ...this.expr(e.whenFalse, c)];
    }
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      let cur = this.expr(e.expression, f);
      const skip = ts.isCallExpression(e) && ts.isOptionalChain(e) ? cur : [];
      const callbacks: (ts.ArrowFunction | ts.FunctionExpression)[] = [];
      for (const arg of e.arguments ?? []) {
        const a = stripParens(arg);
        if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) callbacks.push(a);
        else cur = this.expr(arg, cur);
      }
      for (const cb of callbacks) cur = [...cur, ...this.inline(cb, cur)];
      this.connect(cur, this.throwTo);
      return [...this.node(e, cur), ...skip];
    }
    if (ts.isAwaitExpression(e) || ts.isYieldExpression(e)) {
      return this.node(e, this.expr(e.expression, f));
    }
    if (ts.isObjectLiteralExpression(e)) {
      let cur = f;
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p)) cur = this.expr(p.initializer, this.expr(p.name, cur));
        else if (ts.isSpreadAssignment(p)) cur = this.expr(p.expression, cur);
      }
      return this.node(e, cur);
    }
    let cur = f;
    ts.forEachChild(e, (c) => {
      cur = this.expr(c, cur);
    });
    return cur;
  }
}

export function buildCfg(fn: FunctionLike): Cfg {
  return new Builder().build(fn);
}

/** Nodes reachable from `starts` without entering `blocked` (start nodes are always visited). */
export function reachable(
  cfg: Cfg,
  starts: readonly number[],
  blocked?: ReadonlySet<number>,
): Uint8Array {
  const seen = new Uint8Array(cfg.nodes.length);
  const stack = [...starts];
  for (const s of starts) seen[s] = 1;
  while (stack.length > 0) {
    const n = stack.pop() as number;
    for (const m of cfg.succ[n] ?? []) {
      if (seen[m] || blocked?.has(m)) continue;
      seen[m] = 1;
      stack.push(m);
    }
  }
  return seen;
}
