import type { CmpOp, Expr } from "@tsv/ir";
import { describe, expect, it } from "vitest";
import { type DecodedState, effectConstants, evaluate } from "./eval";

const paid: DecodedState = { status: "paid", effects: { "stripe.refund": 1 } };
const T: Expr = { type: "bool", value: true };
const F: Expr = { type: "bool", value: false };

describe("evaluate", () => {
  it("bool", () => {
    expect(evaluate(T, paid)).toBe(true);
    expect(evaluate(F, paid)).toBe(false);
  });

  it("status-cmp", () => {
    expect(evaluate({ type: "status-cmp", op: "==", value: "paid" }, paid)).toBe(true);
    expect(evaluate({ type: "status-cmp", op: "==", value: "draft" }, paid)).toBe(false);
    expect(evaluate({ type: "status-cmp", op: "!=", value: "paid" }, paid)).toBe(false);
    expect(evaluate({ type: "status-cmp", op: "!=", value: "draft" }, paid)).toBe(true);
  });

  it("status-in", () => {
    expect(evaluate({ type: "status-in", values: ["draft", "paid"] }, paid)).toBe(true);
    expect(evaluate({ type: "status-in", values: ["draft"] }, paid)).toBe(false);
    expect(evaluate({ type: "status-in", values: [] }, paid)).toBe(false);
  });

  it.each<[CmpOp, number, boolean]>([
    ["==", 1, true],
    ["==", 0, false],
    ["!=", 1, false],
    ["!=", 2, true],
    ["<", 2, true],
    ["<", 1, false],
    ["<=", 1, true],
    ["<=", 0, false],
    [">", 0, true],
    [">", 1, false],
    [">=", 1, true],
    [">=", 2, false],
  ])("effect-count %s %i → %s", (op, value, expected) => {
    expect(evaluate({ type: "effect-count", effect: "stripe.refund", op, value }, paid)).toBe(
      expected,
    );
  });

  it("effect-count reads an unknown effect as 0", () => {
    expect(evaluate({ type: "effect-count", effect: "email.x", op: "==", value: 0 }, paid)).toBe(
      true,
    );
  });

  it("not", () => {
    expect(evaluate({ type: "not", expr: T }, paid)).toBe(false);
    expect(evaluate({ type: "not", expr: F }, paid)).toBe(true);
  });

  it.each<["and" | "or" | "implies", boolean, boolean, boolean]>([
    ["and", true, true, true],
    ["and", true, false, false],
    ["and", false, true, false],
    ["and", false, false, false],
    ["or", true, true, true],
    ["or", true, false, true],
    ["or", false, true, true],
    ["or", false, false, false],
    ["implies", true, true, true],
    ["implies", true, false, false],
    ["implies", false, true, true],
    ["implies", false, false, true],
  ])("%s(%s, %s) → %s", (type, l, r, expected) => {
    const expr: Expr = {
      type,
      left: { type: "bool", value: l },
      right: { type: "bool", value: r },
    };
    expect(evaluate(expr, paid)).toBe(expected);
  });

  it("nested expression", () => {
    // status == shipped and count(effect stripe.refund) > 0
    const expr: Expr = {
      type: "and",
      left: { type: "status-cmp", op: "==", value: "shipped" },
      right: { type: "effect-count", effect: "stripe.refund", op: ">", value: 0 },
    };
    expect(evaluate(expr, paid)).toBe(false);
    expect(evaluate(expr, { ...paid, status: "shipped" })).toBe(true);
  });
});

describe("effectConstants", () => {
  it("collects the largest constant per effect through every connective", () => {
    const expr: Expr = {
      type: "implies",
      left: { type: "not", expr: { type: "effect-count", effect: "a", op: ">", value: 3 } },
      right: {
        type: "or",
        left: { type: "effect-count", effect: "a", op: "<", value: 1 },
        right: {
          type: "and",
          left: { type: "effect-count", effect: "b", op: "==", value: 5 },
          right: { type: "status-in", values: ["x"] },
        },
      },
    };
    expect(Object.fromEntries(effectConstants([expr, T]))).toEqual({ a: 3, b: 5 });
  });
});
