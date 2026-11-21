import type { CmpOp, Expr } from "@tsv/ir";

/**
 * How a compiled expression reads a state of type `S`. Resolution happens once at compile time,
 * so the returned closures do no name lookups in the hot path.
 */
export interface ExprAccess<S> {
  /** Predicate `status == value`. */
  statusIs(value: string): (state: S) => boolean;
  /** Reader for `count(effect name)`. Unknown effects must read as 0. */
  count(effect: string): (state: S) => number;
}

export type CompiledExpr<S> = (state: S) => boolean;

/** A decoded state, shaped like `ir.TraceState` (minus workers). */
export interface DecodedState {
  status: string;
  effects: Readonly<Record<string, number>>;
}

function compare(op: CmpOp, a: number, b: number): boolean {
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

/** Compiles a rule expression into a closure over states of type `S`. */
export function compileExpr<S>(expr: Expr, access: ExprAccess<S>): CompiledExpr<S> {
  switch (expr.type) {
    case "bool": {
      const value = expr.value;
      return () => value;
    }
    case "status-cmp": {
      const is = access.statusIs(expr.value);
      return expr.op === "==" ? is : (s) => !is(s);
    }
    case "status-in": {
      const preds = expr.values.map((v) => access.statusIs(v));
      return (s) => preds.some((p) => p(s));
    }
    case "effect-count": {
      const read = access.count(expr.effect);
      const { op, value } = expr;
      return (s) => compare(op, read(s), value);
    }
    case "not": {
      const inner = compileExpr(expr.expr, access);
      return (s) => !inner(s);
    }
    case "and": {
      const l = compileExpr(expr.left, access);
      const r = compileExpr(expr.right, access);
      return (s) => l(s) && r(s);
    }
    case "or": {
      const l = compileExpr(expr.left, access);
      const r = compileExpr(expr.right, access);
      return (s) => l(s) || r(s);
    }
    case "implies": {
      const l = compileExpr(expr.left, access);
      const r = compileExpr(expr.right, access);
      return (s) => !l(s) || r(s);
    }
  }
}

const DECODED_ACCESS: ExprAccess<DecodedState> = {
  statusIs: (value) => (s) => s.status === value,
  count: (effect) => (s) => s.effects[effect] ?? 0,
};

/** Evaluates a rule expression against a decoded state. */
export function evaluate(expr: Expr, state: DecodedState): boolean {
  return compileExpr(expr, DECODED_ACCESS)(state);
}

/** Largest constant each effect is compared against anywhere in `exprs`. */
export function effectConstants(exprs: readonly Expr[]): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (e: Expr): void => {
    switch (e.type) {
      case "effect-count":
        out.set(e.effect, Math.max(out.get(e.effect) ?? 0, e.value));
        return;
      case "not":
        visit(e.expr);
        return;
      case "and":
      case "or":
      case "implies":
        visit(e.left);
        visit(e.right);
        return;
      default:
        return;
    }
  };
  for (const e of exprs) visit(e);
  return out;
}
