import type { Expr } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { parseRule, parseRuleExpr } from "./parser";

function ok(text: string): Expr {
  const result = parseRuleExpr(text);
  if ("error" in result) throw new Error(`unexpected error: ${result.error.message}`);
  return result.expr;
}

function err(text: string): { message: string; offset: number } {
  const result = parseRuleExpr(text);
  if (!("error" in result)) throw new Error(`expected a syntax error for ${text}`);
  return result.error;
}

const A: Expr = { type: "status-cmp", op: "==", value: "a" };
const B: Expr = { type: "status-cmp", op: "==", value: "b" };
const C: Expr = { type: "status-cmp", op: "==", value: "c" };

describe("atoms", () => {
  it("status == / !=", () => {
    expect(ok("status == paid")).toEqual({ type: "status-cmp", op: "==", value: "paid" });
    expect(ok("status!=pending_payment")).toEqual({
      type: "status-cmp",
      op: "!=",
      value: "pending_payment",
    });
  });

  it("status in [...]", () => {
    expect(ok("status in [paid]")).toEqual({ type: "status-in", values: ["paid"] });
    expect(ok("status in [ paid , shipped,refunded ]")).toEqual({
      type: "status-in",
      values: ["paid", "shipped", "refunded"],
    });
  });

  it.each([
    ["==", 1],
    ["!=", 0],
    ["<", 2],
    ["<=", 1],
    [">", 0],
    [">=", 10],
  ] as const)("count(effect …) %s %i", (op, value) => {
    expect(ok(`count(effect stripe.refund) ${op} ${value}`)).toEqual({
      type: "effect-count",
      effect: "stripe.refund",
      op,
      value,
    });
  });

  it("true / false", () => {
    expect(ok("true")).toEqual({ type: "bool", value: true });
    expect(ok("false")).toEqual({ type: "bool", value: false });
  });

  it("parenthesised expressions", () => {
    expect(ok("((status == a))")).toEqual(A);
  });

  it("names may contain dashes, digits and keyword spellings", () => {
    expect(ok("status == in-review2")).toEqual({
      type: "status-cmp",
      op: "==",
      value: "in-review2",
    });
    expect(ok("status == status")).toEqual({ type: "status-cmp", op: "==", value: "status" });
    expect(ok("count(effect count.effect) == 0")).toMatchObject({ effect: "count.effect" });
  });

  it("accepts newlines as whitespace (folded YAML scalars)", () => {
    expect(ok("status == a\n  and status == b")).toEqual({ type: "and", left: A, right: B });
  });
});

describe("operators", () => {
  it("not binds tighter than and", () => {
    expect(ok("not status == a and status == b")).toEqual({
      type: "and",
      left: { type: "not", expr: A },
      right: B,
    });
  });

  it("not nests", () => {
    expect(ok("not not true")).toEqual({
      type: "not",
      expr: { type: "not", expr: { type: "bool", value: true } },
    });
  });

  it("and binds tighter than or", () => {
    expect(ok("status == a or status == b and status == c")).toEqual({
      type: "or",
      left: A,
      right: { type: "and", left: B, right: C },
    });
    expect(ok("status == a and status == b or status == c")).toEqual({
      type: "or",
      left: { type: "and", left: A, right: B },
      right: C,
    });
  });

  it("or binds tighter than implies", () => {
    expect(ok("status == a or status == b implies status == c")).toEqual({
      type: "implies",
      left: { type: "or", left: A, right: B },
      right: C,
    });
  });

  it("and / or are left-associative", () => {
    expect(ok("status == a and status == b and status == c")).toEqual({
      type: "and",
      left: { type: "and", left: A, right: B },
      right: C,
    });
    expect(ok("status == a or status == b or status == c")).toEqual({
      type: "or",
      left: { type: "or", left: A, right: B },
      right: C,
    });
  });

  it("implies is right-associative", () => {
    expect(ok("status == a implies status == b implies status == c")).toEqual({
      type: "implies",
      left: A,
      right: { type: "implies", left: B, right: C },
    });
  });

  it("parentheses override precedence", () => {
    expect(ok("(status == a implies status == b) implies status == c")).toEqual({
      type: "implies",
      left: { type: "implies", left: A, right: B },
      right: C,
    });
    expect(ok("status == a and (status == b or status == c)")).toEqual({
      type: "and",
      left: A,
      right: { type: "or", left: B, right: C },
    });
  });
});

describe("name references", () => {
  it("reports every state and effect with its span", () => {
    const text = "status in [a, b] or count(effect x.y) > 0";
    const result = parseRule(text);
    if ("error" in result) throw new Error(result.error.message);
    expect(result.refs).toEqual([
      { kind: "state", name: "a", offset: 11, end: 12 },
      { kind: "state", name: "b", offset: 14, end: 15 },
      { kind: "effect", name: "x.y", offset: 33, end: 36 },
    ]);
    for (const ref of result.refs) expect(text.slice(ref.offset, ref.end)).toBe(ref.name);
  });
});

describe("syntax errors", () => {
  it.each([
    ["", "empty expression", 0],
    ["   ", "empty expression", 0],
    ["status = paid", 'unexpected character "=" (did you mean "=="?)', 7],
    ["count(effect x) =< 1", 'unexpected character "=" (did you mean "<="?)', 16],
    ["status == a && status == b", 'unexpected character "&" (use "and")', 12],
    ["status == a || true", 'unexpected character "|" (use "or")', 12],
    ["!true", 'unexpected character "!"', 0],
    ["status ==", 'expected a state name after "status ==" but found the end of the expression', 9],
    ["status is paid", 'expected "==", "!=" or "in" after "status" but found "is"', 7],
    ["status in paid", 'expected "[" after "status in" but found "paid"', 10],
    ["status in []", 'expected a state name after "[" but found "]"', 11],
    ["status in [a,]", 'expected a state name after "," but found "]"', 13],
    ["status in [a b]", 'expected "]" to close the state list but found "b"', 13],
    ["count effect x", 'expected "(" after "count" but found "effect"', 6],
    ["count(x) > 1", 'expected "effect" after "count(" but found "x"', 6],
    ["count(effect) > 1", 'expected an effect name after "count(effect" but found ")"', 12],
    ["count(effect x > 1", 'expected ")" to close "count(" but found ">"', 15],
    ["count(effect x) 1", "expected a comparison (==, !=, <, <=, >, >=)", 16],
    ["count(effect x) <= y", 'expected an integer after "<=" but found "y"', 19],
    ["count(effect x) <= 1x", 'invalid number "1x…"', 19],
    ["count(effect x.) == 1", 'expected a name after "." in "x."', 14],
    ["(status == a", 'expected ")" to close "(" but found the end of the expression', 12],
    ["status == a)", 'unexpected ")" (expected "and", "or", "implies" or the end)', 11],
    ["status == a status == b", 'unexpected "status"', 12],
    ["paid", 'expected "status", "count", "true", "false", "not" or "(" but found "paid"', 0],
    ["status == a and", "but found the end of the expression", 15],
    ["not", "but found the end of the expression", 3],
    ["true implies", "but found the end of the expression", 12],
  ])("%j", (text, message, offset) => {
    const e = err(text);
    expect(e.message).toContain(message);
    expect(e.offset).toBe(offset);
  });
});
