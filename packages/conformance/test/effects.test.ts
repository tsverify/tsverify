import { compare } from "@tsverify/conformance";
import { describe, expect, it } from "vitest";
import {
  buildCodeModel,
  cleanWrites,
  patchSpec,
  patchWrite,
  specModel,
  VARIANT_CASES,
  type Write,
} from "./code-model";

function run(writes: Write[]) {
  const spec = specModel();
  return compare(spec, buildCodeModel(spec, writes));
}

describe("effects", () => {
  it("reports a mapped effect the spec does not declare at its call site and transition (B5)", () => {
    const { spec, code } = VARIANT_CASES["b5-undeclared-effect"]();
    expect(compare(spec, code)).toEqual([
      {
        id: "undeclared-effect:Order lifecycle:expire:stripe.refund",
        category: "undeclared-effect",
        severity: "error",
        message:
          "expire: expireOrder calls stripe.refund (stripe.refunds.create), which the spec does not declare for expire.",
        behavior: "Order lifecycle",
        transition: "expire",
        specAt: { file: "src/orders/order.behavior.yaml", line: 37, column: 3 },
        codeAt: { file: "src/jobs/expire-orders.ts", line: 21, column: 11 },
        hint: "Declare stripe.refund under expire.effects, or remove the call.",
      },
    ]);
  });

  it("says when an undeclared effect is an unmapped gate", () => {
    const writes = patchWrite(cleanWrites(), "refund", (w) => ({
      ...w,
      effects: [
        ...w.effects,
        { effect: "stripe.charges.create", gate: "stripe.charges.create", at: [20, 3] },
      ],
    }));
    expect(run(writes)).toEqual([
      expect.objectContaining({
        id: "undeclared-effect:Order lifecycle:refund:stripe.charges.create",
        message:
          "refund: refundOrder calls stripe.charges.create, a gate no spec effect maps to (not in bindings.effects).",
        // No binding to point at: the transition.
        specAt: { file: "src/orders/order.behavior.yaml", line: 52, column: 3 },
        codeAt: { file: "src/orders/refund.ts", line: 20, column: 3 },
        hint: "Declare the effect on refund and map it to stripe.charges.create in bindings.effects, list charges.create under bindings.clients.stripe.reads if it only reads, or remove the call.",
      }),
    ]);
  });

  it("reports a declared effect the code never calls at the write and its declaration", () => {
    const writes = patchWrite(cleanWrites(), "payment_succeeded", (w) => ({ ...w, effects: [] }));
    expect(run(writes)).toEqual([
      {
        id: "missing-effect:Order lifecycle:payment_succeeded:email.receipt",
        category: "missing-effect",
        severity: "error",
        message:
          "payment_succeeded: onPaymentSucceeded never calls email.receipt (email.send) when it writes paid.",
        behavior: "Order lifecycle",
        transition: "payment_succeeded",
        specAt: { file: "src/orders/order.behavior.yaml", line: 34, column: 9 },
        codeAt: { file: "src/payments/webhook.ts", line: 22, column: 5 },
        hint: "Call email.send after the write in onPaymentSucceeded, or remove email.receipt from payment_succeeded.effects.",
      },
    ]);
  });

  it("says it couldn't confirm an effect on a client no call resolves to, as a warning", () => {
    const spec = specModel();
    // The extractor takes the effect as specified (in `effects`, no call site).
    const writes = patchWrite(cleanWrites(), "payment_succeeded", (w) => ({ ...w, effects: [] }));
    const code = buildCodeModel(spec, writes);
    const paid = code.transitions.find((t) => t.name === "payment_succeeded");
    paid?.effects.push({ name: "email.receipt", multiplicity: "exactly-once" });
    const binding = "unanalyzable:Order lifecycle:binding:email";
    expect(compare(spec, { ...code, uncalledClients: { email: binding } })).toEqual([
      {
        id: "missing-effect:Order lifecycle:payment_succeeded:email.receipt",
        category: "missing-effect",
        severity: "warning",
        message:
          "payment_succeeded: couldn't confirm that onPaymentSucceeded calls email.receipt (email.send) when it writes paid: no call in the project resolves to client email, so tsverify can't see its calls.",
        behavior: "Order lifecycle",
        transition: "payment_succeeded",
        specAt: { file: "src/orders/order.behavior.yaml", line: 34, column: 9 },
        codeAt: { file: "src/payments/webhook.ts", line: 22, column: 5 },
        hint: "Fix bindings.clients.email (see the warning on it). Until then email.receipt is taken as specified.",
        causedBy: [binding],
      },
    ]);
  });

  it("reports one finding per effect name, however often it is called", () => {
    const writes = patchWrite(cleanWrites(), "expire", (w) => ({
      ...w,
      effects: [
        { effect: "email.receipt", gate: "email.send", at: [30, 3] },
        { effect: "email.receipt", gate: "email.send", at: [20, 3] },
      ],
    }));
    expect(run(writes)).toEqual([
      expect.objectContaining({
        id: "undeclared-effect:Order lifecycle:expire:email.receipt",
        codeAt: { file: "src/jobs/expire-orders.ts", line: 20, column: 3 },
      }),
    ]);
  });

  it("reports an undeclared effect once when several writes of the transition reach it", () => {
    // refund's impl reaches three writes of `refunded` (refund, refund~2, refund~3), on paths
    // that all call the unmapped gate: one finding, naming the other call site.
    const refund = cleanWrites().find((w) => w.name === "refund") as Write;
    const charge = (line: number) => ({
      effect: "stripe.charges.create",
      gate: "stripe.charges.create",
      at: [line, 3] as [number, number],
    });
    const writes = [
      ...patchWrite(cleanWrites(), "refund", (w) => ({
        ...w,
        effects: [...w.effects, charge(20)],
      })),
      { ...refund, name: "refund~2", write: [30, 5] as [number, number], effects: [charge(20)] },
      { ...refund, name: "refund~3", write: [40, 5] as [number, number], effects: [charge(44)] },
    ];
    const findings = run(writes).filter((f) => f.category === "undeclared-effect");
    expect(findings.map((f) => [f.id, f.message])).toEqual([
      [
        "undeclared-effect:Order lifecycle:refund:stripe.charges.create",
        "refund: refundOrder calls stripe.charges.create, a gate no spec effect maps to (not in bindings.effects) (also called at src/orders/refund.ts:44).",
      ],
    ]);
  });

  it("falls back to the transition when the spec has no effect locations", () => {
    const located = specModel();
    const { effectsAt: _, ...bindings } = located.bindings;
    const spec = patchSpec({ ...located, bindings }, "payment_succeeded", (t) => ({
      ...t,
      effects: t.effects.map(({ at: _at, ...e }) => e),
    }));
    const writes = patchWrite(cleanWrites(), "payment_succeeded", (w) => ({
      ...w,
      effects: [{ effect: "stripe.refund", gate: "stripe.refunds.create", at: [28, 9] }],
    }));
    const findings = compare(spec, buildCodeModel(spec, writes));
    expect(findings.map((f) => [f.category, f.specAt?.line])).toEqual([
      ["missing-effect", 27],
      ["undeclared-effect", 27],
    ]);
  });
});
