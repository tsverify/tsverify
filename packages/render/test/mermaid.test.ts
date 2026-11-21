import { orderModel } from "@tsv/ir/testing";
import { toMermaid } from "@tsv/render";
import { describe, expect, it } from "vitest";
import { codeAnyStateModel, escapingModel, nonAtomicRefundModel } from "./models";

describe("toMermaid", () => {
  it("renders the Order model", async () => {
    await expect(toMermaid(orderModel())).toMatchFileSnapshot("__golden__/order.mmd");
  });

  it("highlights states with a class and transitions with a label marker", async () => {
    const out = toMermaid(orderModel(), {
      highlight: { states: ["refunded", "paid", "nope"], transitions: ["refund", "nope"] },
    });
    expect(out).toContain("  class paid,refunded highlight\n");
    expect(out).toContain("  paid --> refunded: ▶ refund · admin");
    await expect(out).toMatchFileSnapshot("__golden__/order-highlight.mmd");
  });

  it("draws a from: * transition from every state", async () => {
    const out = toMermaid(codeAnyStateModel());
    const refundEdges = out.split("\n").filter((l) => l.includes(": refund (any state)"));
    expect(refundEdges).toHaveLength(orderModel().entity.states.length);
    await expect(out).toMatchFileSnapshot("__golden__/order-code-any-state.mmd");
  });

  it("marks a non-atomic transition that has an exactly-once effect", async () => {
    const out = toMermaid(nonAtomicRefundModel());
    expect(out).toContain("refund · admin · stripe.refund ×1 · ⚠ non-atomic\n");
    // checkout is non-atomic too, but has no exactly-once effect.
    expect(out).toContain("checkout · customer (owner)\n");
    await expect(out).toMatchFileSnapshot("__golden__/order-non-atomic-refund.mmd");
  });

  it("escapes ids and labels", async () => {
    const out = toMermaid(escapingModel());
    expect(out).toContain('  state "on-hold" as on_hold_2\n');
    expect(out).toContain('  state "end" as s_end\n');
    expect(out).toContain("  open --> on_hold_2: hold#58; see #35;42 · agent (team(a#59;b))");
    // No raw label-breaking character survives after an edge's `: `.
    for (const line of out.split("\n").filter((l) => l.includes("-->") && l.includes(": "))) {
      const label = line.slice(line.indexOf(": ") + 2).replace(/#\d+;/g, "");
      expect(label).not.toMatch(/[:;#"<>{}%]/);
    }
    await expect(out).toMatchFileSnapshot("__golden__/escaping.mmd");
  });

  it("is deterministic regardless of transition order in the input", () => {
    const model = orderModel();
    const reversed = { ...model, transitions: [...model.transitions].reverse() };
    expect(toMermaid(reversed)).toBe(toMermaid(model));
  });
});
