import { compare } from "@tsverify/conformance";
import { describe, expect, it } from "vitest";
import {
  buildCodeModel,
  cleanWrites,
  patchSpec,
  patchWrite,
  specModel,
  strictExpire,
  VARIANT_CASES,
  type Write,
} from "./code-model";

function run(writes: Write[], spec = specModel()) {
  return compare(spec, buildCodeModel(spec, writes));
}

function withFrom(name: string, values: string[] | "*", unconstrained = false): Write[] {
  return patchWrite(cleanWrites(), name, (w) => ({
    ...w,
    fromState: { values, unconstrained },
  }));
}

describe("from-states", () => {
  it("reports an unconstrained write with the extractor's reason (B4)", () => {
    const { spec, code } = VARIANT_CASES["b4-webhook-dup"]();
    expect(compare(spec, code)).toEqual([
      {
        id: "from-state-unconstrained:Order lifecycle:payment_succeeded",
        category: "from-state-unconstrained",
        severity: "error",
        message:
          "payment_succeeded: onPaymentSucceeded writes paid from any state (no status check before the write); the spec allows only pending_payment.",
        behavior: "Order lifecycle",
        transition: "payment_succeeded",
        // The first `from` item, where the allowed states are listed.
        specAt: { file: "src/orders/order.behavior.yaml", line: 28, column: 11 },
        codeAt: { file: "src/payments/webhook.ts", line: 18, column: 5 },
        hint: "Check that status is 'pending_payment' before the write, inside the same atomic scope.",
      },
    ]);
  });

  it("treats a full-union narrowed type as unconstrained, with a default reason", () => {
    const states = specModel().entity.states;
    const [finding] = run(withFrom("ship", states, true));
    expect(finding?.category).toBe("from-state-unconstrained");
    expect(finding?.message).toBe(
      "ship: shipOrder writes shipped from any state (status is not checked before the write); the spec allows only paid.",
    );
  });

  it("leaves an unknown from-state to the extractor's unanalyzable finding", () => {
    // `values: "*"` (e.g. a `string`-typed field) is reported once, by the extractor.
    expect(run(withFrom("ship", "*", false))).toEqual([]);
    expect(run(withFrom("ship", "*", true))).toEqual([]);
  });

  it("points an unconstrained write at the transition without from locations", () => {
    const spec = patchSpec(specModel(), "ship", ({ fromAt: _, ...t }) => t);
    const [finding] = run(withFrom("ship", specModel().entity.states, true), spec);
    expect(finding?.specAt).toEqual({
      file: "src/orders/order.behavior.yaml",
      line: 45,
      column: 3,
    });
  });

  it("accepts an unconstrained write when the spec allows any state", () => {
    const spec = patchSpec(specModel(), "ship", (t) => ({ ...t, from: "*" }));
    expect(run(withFrom("ship", "*", true), spec)).toEqual([]);
  });

  it("says when the extra states belong to another transition with the same impl and to", () => {
    // ship: paid → shipped, and reship: refunded → shipped, both with impl shipOrder. The one
    // write is linked to both, and each sees both from-states.
    const base = specModel();
    const ship = base.transitions.find((t) => t.name === "ship");
    if (!ship) throw new Error("no ship");
    const spec = {
      ...base,
      transitions: [...base.transitions, { ...ship, name: "reship", from: ["refunded"] }],
      concurrency: { ...base.concurrency, reship: 2 },
    };
    const both = { values: ["paid", "refunded"], unconstrained: false };
    const shipWrite = cleanWrites().find((w) => w.name === "ship") as Write;
    const writes = [
      ...patchWrite(cleanWrites(), "ship", (w) => ({ ...w, fromState: both })),
      { ...shipWrite, name: "reship", specTransition: "reship", fromState: both },
    ];
    const findings = run(writes, spec).filter((f) => f.category === "from-state-mismatch");
    expect(findings.map((f) => [f.id, f.severity])).toEqual([
      ["from-state-mismatch:Order lifecycle:reship:paid", "error"],
      ["from-state-mismatch:Order lifecycle:ship:refunded", "error"],
    ]);
    expect(findings[1]?.message).toBe(
      "ship: shipOrder also writes shipped from refunded, which ship does not allow (from: paid) but reship does: ship and reship share the impl shipOrder and `to: shipped`, so tsverify can't tell which of the write's from-states is whose.",
    );
    expect(findings[1]?.hint).toBe(
      "Merge ship and reship into one transition (from: {paid, refunded}), or give each its own impl (one function per from-state, each checking only its own).",
    );
  });

  it("reports extra source states as an error", () => {
    const findings = run(withFrom("checkout", ["cancelled", "draft"]));
    expect(findings).toEqual([
      expect.objectContaining({
        id: "from-state-mismatch:Order lifecycle:checkout:cancelled",
        severity: "error",
        message:
          "checkout: checkout also writes pending_payment from cancelled, which the spec does not allow (from: draft).",
        // The from list, where the extra state could be added.
        specAt: { file: "src/orders/order.behavior.yaml", line: 20, column: 11 },
        codeAt: { file: "src/orders/checkout.ts", line: 13, column: 5 },
        hint: "Tighten the check before the write to status is 'draft', or add cancelled to checkout.from.",
      }),
    ]);
  });

  it("reports a stricter code from-set as a warning, at the missing state's from item", () => {
    const spec = patchSpec(specModel(), "expire", strictExpire);
    const findings = run(cleanWrites(), spec);
    expect(findings).toEqual([
      expect.objectContaining({
        id: "from-state-mismatch:Order lifecycle:expire:draft",
        severity: "warning",
        message:
          "expire: expireOrder only writes cancelled from pending_payment; the spec also allows draft.",
        hint: "Remove draft from expire.from, or let the code accept it.",
        specAt: { file: "src/orders/order.behavior.yaml", line: 38, column: 12 },
      }),
    ]);
  });

  describe("an impl with several writes of `to`", () => {
    // expire: from [draft, pending_payment]; the impl reaches two writes of cancelled.
    const strict = () => patchSpec(specModel(), "expire", strictExpire);
    const twoSites = (first: string[], second: string[]): Write[] => {
      const writes = withFrom("expire", first);
      const expire = writes.find((w) => w.name === "expire") as Write;
      return [
        ...writes,
        {
          ...expire,
          name: "expire~2",
          fn: "expireDraft",
          write: [40, 5],
          fromState: { values: second, unconstrained: false },
        },
      ];
    };

    it("compares the from-states the writes accept together", () => {
      expect(run(twoSites(["pending_payment"], ["draft"]), strict())).toEqual([]);
    });

    it("reports what none of them accepts once, naming every write's function", () => {
      const spec = patchSpec(strict(), "expire", (t) => ({
        ...t,
        from: ["draft", "pending_payment", "paid"],
        fromAt: [
          ...(t.fromAt ?? []),
          { file: "src/orders/order.behavior.yaml", line: 38, column: 30 },
        ],
      }));
      expect(run(twoSites(["pending_payment"], ["draft"]), spec)).toEqual([
        expect.objectContaining({
          id: "from-state-mismatch:Order lifecycle:expire:paid",
          severity: "warning",
          message:
            "expire: its 2 writes of cancelled (in expireOrder, expireDraft) together only write it from {draft, pending_payment}; the spec also allows paid.",
          specAt: { file: "src/orders/order.behavior.yaml", line: 38, column: 30 },
        }),
      ]);
    });

    it("still reports a state one write accepts against the spec, per write", () => {
      expect(
        run(twoSites(["pending_payment"], ["draft", "paid"]), strict()).map((f) => f.id),
      ).toEqual(["from-state-mismatch:Order lifecycle:expire:paid:expire~2"]);
    });
  });

  it("points at the from item of whichever state the code does not accept", () => {
    const spec = patchSpec(specModel(), "expire", strictExpire);
    const writes = withFrom("expire", ["draft"]);
    const findings = run(writes, spec);
    expect(findings.map((f) => [f.id, f.specAt?.column])).toEqual([
      ["from-state-mismatch:Order lifecycle:expire:pending_payment", 19],
    ]);
  });

  it("reports both directions when the sets are incomparable", () => {
    const findings = run(withFrom("ship", ["shipped"]));
    expect(findings.map((f) => [f.id, f.severity])).toEqual([
      ["from-state-mismatch:Order lifecycle:ship:paid", "warning"],
      ["from-state-mismatch:Order lifecycle:ship:shipped", "error"],
    ]);
  });

  it("compares against every entity state when the spec says from: '*'", () => {
    const spec = patchSpec(specModel(), "ship", (t) => ({ ...t, from: "*" }));
    const [finding] = run(withFrom("ship", ["paid"]), spec);
    expect(finding).toMatchObject({
      id: "from-state-mismatch:Order lifecycle:ship:draft,pending_payment,shipped,refunded,cancelled",
      severity: "warning",
      // No from items to point at: the transition.
      specAt: { file: "src/orders/order.behavior.yaml", line: 45, column: 3 },
    });
  });

  it("falls back to the transition when the spec has no from locations", () => {
    const spec = patchSpec(specModel(), "checkout", ({ fromAt: _, ...t }) => t);
    const [finding] = run(withFrom("checkout", ["cancelled", "draft"]), spec);
    expect(finding?.specAt).toEqual({
      file: "src/orders/order.behavior.yaml",
      line: 19,
      column: 3,
    });
  });
});
