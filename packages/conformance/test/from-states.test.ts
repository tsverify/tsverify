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
        specAt: { file: "src/orders/order.behavior.yaml", line: 27, column: 3 },
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

  it("accepts an unconstrained write when the spec allows any state", () => {
    const spec = patchSpec(specModel(), "ship", (t) => ({ ...t, from: "*" }));
    expect(run(withFrom("ship", "*", true), spec)).toEqual([]);
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
