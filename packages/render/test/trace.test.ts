import type { Trace } from "@tsv/ir";
import { traceToSequenceDiagram, traceToText } from "@tsv/render";
import { describe, expect, it } from "vitest";
import { b6DoubleRefundTrace } from "./b6-trace";

describe("traceToText", () => {
  it("renders the B6 double-refund trace", async () => {
    const out = traceToText(b6DoubleRefundTrace());
    expect(out.startsWith("step 0  status=draft\n")).toBe(true);
    expect(out).toContain(
      "step 7  refund#2 write  status=refunded  stripe.refund=2  ✗ effect-multiplicity\n",
    );
    await expect(out).toMatchFileSnapshot("__golden__/b6-double-refund.txt");
  });

  it("shows rejected and duplicate actions, and workers that do not name their transition", () => {
    const trace: Trace = {
      behavior: "Order lifecycle",
      entity: "Order",
      model: "code",
      property: "rule:Refund issued at most once per order",
      kind: "invariant",
      steps: [
        { index: 0, state: { status: "paid", effects: {}, workers: [] } },
        {
          index: 1,
          action: { worker: "w1", transition: "refund", kind: "atomic", outcome: "rejected" },
          state: { status: "paid", effects: {}, workers: [] },
        },
        {
          index: 2,
          action: {
            worker: "payment_succeeded#2",
            transition: "payment_succeeded",
            kind: "atomic",
            outcome: "proceed",
            duplicate: true,
          },
          state: { status: "paid", effects: {}, workers: [] },
        },
      ],
    };
    expect(traceToText(trace)).toBe(
      [
        "step 0  status=paid",
        "step 1  w1 (refund) atomic → rejected  status=paid",
        "step 2  payment_succeeded#2 atomic → proceed (duplicate delivery)  status=paid  ✗ rule:Refund issued at most once per order",
        "",
      ].join("\n"),
    );
    const diagram = traceToSequenceDiagram(trace);
    expect(diagram).toContain("  w1-xEntity: refund atomic → rejected\n");
    expect(diagram).toContain(
      "  Note over payment_succeeded_2,Entity: ✗ rule#58;Refund issued at most once per order\n",
    );
  });
});

describe("traceToSequenceDiagram", () => {
  it("renders the B6 double-refund trace", async () => {
    const out = traceToSequenceDiagram(b6DoubleRefundTrace(), { entity: "Order" });
    expect(out).toContain("  participant Entity as Order\n");
    expect(out).toContain("  participant refund_1 as refund#35;1\n");
    await expect(out).toMatchFileSnapshot("__golden__/b6-double-refund.mmd");
  });

  it("labels the entity from the trace by default", () => {
    const trace = b6DoubleRefundTrace();
    expect(traceToSequenceDiagram(trace)).toBe(traceToSequenceDiagram(trace, { entity: "Order" }));
  });
});
