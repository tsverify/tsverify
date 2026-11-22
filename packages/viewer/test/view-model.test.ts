import type { Finding } from "@tsverify/ir";
import { summarize } from "@tsverify/render";
import { describe, expect, it } from "vitest";
import { flattenNodes, groupByRootCause, severityCounts } from "../src/app/findings-tree";
import { actionLabel, playthrough } from "../src/app/frames";
import { parseInline, parseMarkdown } from "../src/app/markdown";
import { tracedFinding, variantInput } from "./fixtures";

describe("playthrough (B3, code model)", () => {
  const input = variantInput("b3-refund-race");
  const finding = tracedFinding(input, "effect-multiplicity");
  const view = playthrough(finding.trace, input.code, finding);

  it("has one frame per step, with the status and acting transition highlighted", () => {
    expect(view.frames.map((f) => [f.status, f.label, f.highlight.transitions])).toEqual([
      ["draft", "initial state", []],
      ["pending_payment", "checkout#1 atomic → proceed", ["checkout"]],
      ["paid", "payment_succeeded#1 atomic → proceed", ["payment_succeeded"]],
      ["paid", "refund#1 read → proceed", ["refund"]],
      ["paid", "refund#2 read → proceed", ["refund"]],
      ["refunded", "refund#1 write", ["refund"]],
      ["refunded", "refund#2 write", ["refund"]],
    ]);
    expect(view.frames.every((f) => f.highlight.states[0] === f.status)).toBe(true);
    expect(view.frames[6]?.text).toBe(
      "step 6  refund#2 write  status=refunded  stripe.refund=2  ✗ effect-multiplicity",
    );
  });

  it("counts effects, with the exactly-once limit and the violated one marked on the last step", () => {
    const last = view.frames.at(-1);
    expect(last?.effects).toEqual([
      { name: "email.receipt", count: 1, delta: 0, limit: 1, over: false, violated: false },
      { name: "stripe.refund", count: 2, delta: 1, limit: 1, over: true, violated: true },
    ]);
    expect(view.frames[5]?.effects[1]).toMatchObject({ count: 1, over: false, violated: false });
    expect(last?.violation).toEqual({
      property: "effect-multiplicity",
      description: "An exactly-once effect fires at most once per entity in every reachable state.",
      effects: ["stripe.refund"],
    });
    expect(view.frames.slice(0, -1).some((f) => f.violation)).toBe(false);
  });

  it("draws one swimlane per acting worker with phase and observed status", () => {
    expect(view.lanes.map((l) => l.worker)).toEqual([
      "checkout#1",
      "payment_succeeded#1",
      "refund#1",
      "refund#2",
    ]);
    const refund2 = view.lanes[3];
    expect(refund2?.cells.map((c) => [c.phase, c.observed ?? "", c.acting?.kind ?? ""])).toEqual([
      ["idle", "", ""],
      ["idle", "", ""],
      ["idle", "", ""],
      ["idle", "", ""],
      ["checked", "paid", "read"],
      ["checked", "paid", ""],
      ["done", "paid", "write"],
    ]);
    expect(view.idleWorkers).toEqual([
      "checkout#2",
      "expire#1",
      "expire#2",
      "payment_succeeded#2",
      "ship#1",
      "ship#2",
    ]);
  });

  it("marks the effects a rule is about", () => {
    const rule = tracedFinding(input, "rule:Refund issued at most once per order");
    const last = playthrough(rule.trace, input.code, rule).frames.at(-1);
    expect(last?.violation).toEqual({
      property: "rule:Refund issued at most once per order",
      description:
        "Refund issued at most once per order (always: count(effect stripe.refund) <= 1)",
      effects: ["stripe.refund"],
    });
    expect(last?.effects.filter((e) => e.violated).map((e) => e.name)).toEqual(["stripe.refund"]);
  });

  it("falls back to the effects over their limit without the finding", () => {
    const last = playthrough(finding.trace, input.code).frames.at(-1);
    expect(last?.violation?.effects).toEqual(["stripe.refund"]);
  });
});

describe("playthrough (B6, spec model)", () => {
  it("plays the spec's own counterexample", () => {
    const input = variantInput("b6-spec-race");
    const finding = tracedFinding(input, "effect-multiplicity");
    expect(finding.trace.model).toBe("spec");
    const view = playthrough(finding.trace, input.spec, finding);
    expect(view.frames.at(-1)?.status).toBe("refunded");
    expect(view.lanes.map((l) => l.transition)).toContain("refund");
  });
});

describe("actionLabel", () => {
  it("names the transition when the worker id doesn't, and marks duplicates", () => {
    expect(
      actionLabel({ worker: "w1", transition: "refund", kind: "atomic", duplicate: true }),
    ).toBe("w1 (refund) atomic (duplicate delivery)");
  });
});

function finding(id: string, extra: Partial<Finding> = {}): Finding {
  return { id, category: "non-atomic", severity: "error", message: id, ...extra };
}

describe("groupByRootCause", () => {
  it("nests consequences under their cause (B3)", () => {
    const input = variantInput("b3-refund-race");
    const tree = groupByRootCause(input.findings);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.finding.category).toBe("non-atomic");
    expect(tree[0]?.consequences.map((c) => c.finding.property)).toEqual([
      "effect-multiplicity",
      "rule:Refund issued at most once per order",
    ]);
    expect(flattenNodes(tree)).toHaveLength(3);
    expect(severityCounts(input.findings)).toEqual({ error: 3, warning: 0, info: 0 });
  });

  it("orders by severity, ignores missing causes and breaks cycles", () => {
    const tree = groupByRootCause([
      finding("info", { severity: "info" }),
      finding("a", { causedBy: ["b"] }),
      finding("b", { causedBy: ["a"] }),
      finding("orphan", { causedBy: ["gone"] }),
    ]);
    // `a` → `b` is linked first (in display order); `b` → `a` would close the cycle.
    expect(tree.map((n) => n.finding.id)).toEqual(["b", "orphan", "info"]);
    expect(tree[0]?.consequences.map((n) => n.finding.id)).toEqual(["a"]);
  });
});

describe("parseMarkdown", () => {
  it("reads the summary render writes", () => {
    const input = variantInput("b6-spec-race");
    const blocks = parseMarkdown(summarize(input.spec as NonNullable<typeof input.spec>));
    expect(blocks[0]).toMatchObject({ type: "p" });
    expect(blocks[0]?.type === "p" && blocks[0].inlines[0]).toEqual({
      type: "strong",
      text: "Order lifecycle",
    });
    expect(blocks.map((b) => b.type)).toEqual(["p", "p", "ul", "p", "ul"]);
  });

  it("handles escapes, code spans and unclosed markers", () => {
    expect(parseInline("a \\*b\\* **c\\_d** `x` ``y`z`` **open")).toEqual([
      { type: "text", text: "a *b* " },
      { type: "strong", text: "c_d" },
      { type: "text", text: " " },
      { type: "code", text: "x" },
      { type: "text", text: " " },
      { type: "code", text: "y`z" },
      { type: "text", text: " **open" },
    ]);
  });
});
