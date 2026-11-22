import { compare } from "@tsv/conformance";
import { describe, expect, it } from "vitest";
import {
  buildCodeModel,
  cleanWrites,
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
  it("reports a mapped effect the spec does not declare at its call site (B5)", () => {
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
        codeAt: { file: "src/orders/refund.ts", line: 20, column: 3 },
        hint: "Declare the effect on refund and map it to stripe.charges.create in bindings.effects, or remove the call.",
      }),
    ]);
  });

  it("reports a declared effect the code never calls at the write", () => {
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
        specAt: { file: "src/orders/order.behavior.yaml", line: 27, column: 3 },
        codeAt: { file: "src/payments/webhook.ts", line: 22, column: 5 },
        hint: "Call email.send after the write in onPaymentSucceeded, or remove email.receipt from payment_succeeded.effects.",
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
});
