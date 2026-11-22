import { compare } from "@tsverify/conformance";
import { describe, expect, it } from "vitest";
import {
  buildCodeModel,
  cleanWrites,
  extraRefundWrite,
  patchSpec,
  patchWrite,
  REFUND_IMPL_AT,
  specModel,
  VARIANT_CASES,
  type Write,
} from "./code-model";

function run(writes: Write[], spec = specModel()) {
  return compare(spec, buildCodeModel(spec, writes));
}

const REFUND_SPEC_AT = { file: "src/orders/order.behavior.yaml", line: 52, column: 3 };

describe("transitions", () => {
  it("reports an unlinked write as undeclared, naming the function and states", () => {
    const { spec, code } = VARIANT_CASES["b1-reopen"]();
    expect(compare(spec, code)).toEqual([
      {
        id: "undeclared-transition:Order lifecycle:reopenOrder",
        category: "undeclared-transition",
        severity: "error",
        message: "reopenOrder writes paid → pending_payment, which no spec transition declares.",
        behavior: "Order lifecycle",
        transition: "reopenOrder",
        codeAt: { file: "src/admin/orders.ts", line: 25, column: 5 },
        hint: "Declare this transition in the spec with impl: src/admin/orders.ts#reopenOrder, or remove the write.",
      },
    ]);
  });

  it("reports a linked write to another state as undeclared, and keeps checking the primary", () => {
    const findings = run([...cleanWrites(), extraRefundWrite("cancelled")]);
    expect(findings).toEqual([
      {
        id: "undeclared-transition:Order lifecycle:refund:refund->cancelled",
        category: "undeclared-transition",
        severity: "error",
        message:
          "refund: refundOrder also writes paid → cancelled, but refund only goes to refunded.",
        behavior: "Order lifecycle",
        transition: "refund",
        specAt: REFUND_SPEC_AT,
        codeAt: { file: "src/orders/refund.ts", line: 19, column: 5 },
        hint: "Remove the write to cancelled, or declare it as its own transition in the spec.",
      },
    ]);
  });

  it("says when the written state is not a state of the entity", () => {
    const [finding] = run([...cleanWrites(), extraRefundWrite("archived")]);
    expect(finding?.message).toBe(
      "refund: refundOrder also writes paid → archived, but refund only goes to refunded ('archived' is not a state of Order).",
    );
  });

  it("reports a missing transition when the impl never writes t.to", () => {
    const findings = run(cleanWrites().filter((w) => w.name !== "refund"));
    expect(findings).toEqual([
      {
        id: "missing-transition:Order lifecycle:refund",
        category: "missing-transition",
        severity: "error",
        message: "refund: src/orders/refund.ts#refundOrder never writes status = refunded.",
        behavior: "Order lifecycle",
        transition: "refund",
        specAt: REFUND_SPEC_AT,
        hint: "Set status to 'refunded' in refundOrder (or a function it calls), or fix impl.",
      },
    ]);
  });

  it("points a missing transition's codeAt at the impl declaration (code.implAt)", () => {
    const spec = specModel();
    const code = buildCodeModel(
      spec,
      cleanWrites().filter((w) => w.name !== "refund"),
    );
    const [finding] = compare(spec, { ...code, implAt: { refund: REFUND_IMPL_AT } });
    expect(finding).toMatchObject({
      id: "missing-transition:Order lifecycle:refund",
      specAt: REFUND_SPEC_AT,
      codeAt: REFUND_IMPL_AT,
    });
    // Another transition's implAt is not used.
    const [other] = compare(spec, { ...code, implAt: { ship: REFUND_IMPL_AT } });
    expect(other?.codeAt).toBeUndefined();
  });

  it("reports a linked write to the wrong state as both undeclared and missing", () => {
    const writes = patchWrite(cleanWrites(), "ship", (w) => ({
      ...w,
      name: "ship->refunded",
      to: "refunded",
    }));
    expect(run(writes).map((f) => f.id)).toEqual([
      "missing-transition:Order lifecycle:ship",
      "undeclared-transition:Order lifecycle:ship:ship->refunded",
    ]);
  });

  it("reports a spec transition without impl as info, and its write as unlinked", () => {
    const spec = patchSpec(specModel(), "checkout", ({ impl: _, ...t }) => t);
    const writes = patchWrite(cleanWrites(), "checkout", ({ specTransition: _, ...w }) => w);
    const findings = run(writes, spec);
    expect(findings).toEqual([
      {
        id: "unanalyzable:Order lifecycle:checkout",
        category: "unanalyzable",
        severity: "info",
        message: "checkout: not linked to code (no impl), so it is not checked against the code.",
        behavior: "Order lifecycle",
        transition: "checkout",
        specAt: { file: "src/orders/order.behavior.yaml", line: 19, column: 3 },
        hint: "Add impl: path/to/file.ts#function to checkout to check it against the code.",
      },
      expect.objectContaining({ id: "undeclared-transition:Order lifecycle:checkout" }),
    ]);
  });

  it("orders findings by spec transition, then category, then id; unlinked writes last", () => {
    const writes = [
      ...cleanWrites().filter((w) => w.name !== "ship"),
      extraRefundWrite("cancelled"),
      { ...extraRefundWrite("draft"), name: "zapOrder", specTransition: undefined, fn: "zapOrder" },
      { ...extraRefundWrite("draft"), name: "archiveOrder", specTransition: undefined },
    ];
    expect(run(writes).map((f) => f.id)).toEqual([
      "undeclared-transition:Order lifecycle:refund:refund->cancelled",
      "missing-transition:Order lifecycle:ship",
      "undeclared-transition:Order lifecycle:archiveOrder",
      "undeclared-transition:Order lifecycle:zapOrder",
    ]);
  });
});
