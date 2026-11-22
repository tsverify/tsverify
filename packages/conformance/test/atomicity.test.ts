import { compare } from "@tsverify/conformance";
import { describe, expect, it } from "vitest";
import { buildCodeModel, cleanWrites, patchWrite, specModel, VARIANT_CASES } from "./code-model";

describe("atomicity", () => {
  it("reports a non-atomic refund at the read (B3)", () => {
    const { spec, code } = VARIANT_CASES["b3-refund-race"]();
    expect(compare(spec, code)).toEqual([
      {
        id: "non-atomic:Order lifecycle:refund",
        category: "non-atomic",
        severity: "error",
        message:
          "refund: refundOrder reads the entity (db.orders.get) and writes refunded outside one atomic scope; the spec says atomic.",
        behavior: "Order lifecycle",
        transition: "refund",
        specAt: { file: "src/orders/order.behavior.yaml", line: 52, column: 3 },
        codeAt: { file: "src/orders/refund.ts", line: 10, column: 23 },
        hint: "Wrap the read and write in one transaction or use a conditional update.",
      },
    ]);
  });

  it("falls back to the write when no read was found", () => {
    const spec = specModel();
    const writes = patchWrite(cleanWrites(), "ship", ({ transaction: _, read: __, ...w }) => w);
    expect(compare(spec, buildCodeModel(spec, writes))).toEqual([
      expect.objectContaining({
        id: "non-atomic:Order lifecycle:ship",
        message:
          "ship: shipOrder reads the entity and writes shipped outside one atomic scope; the spec says atomic.",
        codeAt: { file: "src/admin/orders.ts", line: 13, column: 5 },
      }),
    ]);
  });

  it("accepts atomic code for a spec that does not require it (B6)", () => {
    const { spec, code } = VARIANT_CASES["b6-spec-race"]();
    expect(compare(spec, code)).toEqual([]);
  });
});
