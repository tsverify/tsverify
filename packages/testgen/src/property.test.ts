import { describe, expect, it } from "vitest";
import { compile } from "./property";

describe("compile", () => {
  const gate = (effect: string) => (effect === "stripe.refund" ? "stripe.refunds.create" : effect);

  it("turns rule expressions into code over status and effects", () => {
    expect(
      compile(
        {
          type: "and",
          left: { type: "status-cmp", op: "==", value: "shipped" },
          right: { type: "effect-count", effect: "stripe.refund", op: ">", value: 0 },
        },
        gate,
      ),
    ).toBe('status === "shipped" && (effects["stripe.refunds.create"] ?? 0) > 0');
    expect(
      compile(
        {
          type: "implies",
          left: { type: "status-in", values: ["paid", "shipped"] },
          right: {
            type: "or",
            left: { type: "bool", value: false },
            right: { type: "not", expr: { type: "status-cmp", op: "!=", value: "paid" } },
          },
        },
        gate,
      ),
    ).toBe('!((status === "paid" || status === "shipped")) || (false || !(status !== "paid"))');
  });
});
