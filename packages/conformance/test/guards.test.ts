import { compare } from "@tsverify/conformance";
import { describe, expect, it } from "vitest";
import {
  buildCodeModel,
  cleanWrites,
  patchSpec,
  patchWrite,
  specModel,
  VARIANT_CASES,
} from "./code-model";

describe("guards", () => {
  it("points at the non-dominating guard call and the actor's requires item (B2)", () => {
    const { spec, code } = VARIANT_CASES["b2-guard-bypass"]();
    expect(compare(spec, code)).toEqual([
      {
        id: "guard-not-dominating:Order lifecycle:refund:role(admin)",
        category: "guard-not-dominating",
        severity: "error",
        message:
          "refund: role(admin) (requireRole) is called on some paths but not all before the write (required by actor admin).",
        behavior: "Order lifecycle",
        transition: "refund",
        specAt: { file: "src/orders/order.behavior.yaml", line: 14, column: 44 },
        codeAt: { file: "src/orders/refund.ts", line: 21, column: 3 },
        hint: "Call requireRole on every path from refundOrder to the write, before any early return.",
      },
    ]);
  });

  it("points at the write when the guard is never called", () => {
    const spec = specModel();
    const writes = patchWrite(cleanWrites(), "checkout", (w) => ({ ...w, guards: [] }));
    expect(compare(spec, buildCodeModel(spec, writes))).toEqual([
      expect.objectContaining({
        id: "guard-not-dominating:Order lifecycle:checkout:owner",
        message:
          "checkout: owner (requireOwner) is never called before the write (required by checkout.requires).",
        specAt: { file: "src/orders/order.behavior.yaml", line: 23, column: 16 },
        codeAt: { file: "src/orders/checkout.ts", line: 13, column: 5 },
      }),
    ]);
  });

  it("merges transition and actor requirements, one finding per guard", () => {
    const at = (column: number) => ({ file: "src/orders/order.behavior.yaml", line: 49, column });
    const spec = patchSpec(specModel(), "ship", (t) => ({
      ...t,
      requires: [
        { name: "role", args: ["admin"], raw: "role(admin)", at: at(16) },
        { name: "owner", args: [], raw: "owner", at: at(29) },
      ],
    }));
    const writes = patchWrite(cleanWrites(), "ship", (w) => ({ ...w, guards: [] }));
    const findings = compare(spec, buildCodeModel(spec, writes));
    expect(findings.map((f) => f.message)).toEqual([
      "ship: owner (requireOwner) is never called before the write (required by ship.requires).",
      "ship: role(admin) (requireRole) is never called before the write (required by ship.requires, actor admin).",
    ]);
    // A guard the transition lists points at that item, not at the actor's.
    expect(findings.map((f) => f.specAt)).toEqual([at(29), at(16)]);
  });

  it("falls back to the transition when the requires item has no location", () => {
    const spec = patchSpec(specModel(), "checkout", (t) => ({
      ...t,
      requires: t.requires.map(({ at: _, ...g }) => g),
    }));
    const writes = patchWrite(cleanWrites(), "checkout", (w) => ({ ...w, guards: [] }));
    expect(compare(spec, buildCodeModel(spec, writes))[0]?.specAt).toEqual({
      file: "src/orders/order.behavior.yaml",
      line: 19,
      column: 3,
    });
  });

  it("ignores guards the code calls but the spec does not require", () => {
    const spec = specModel();
    const writes = patchWrite(cleanWrites(), "expire", (w) => ({
      ...w,
      guards: [{ guard: "role(admin)", at: [10, 3], dominates: false }],
    }));
    expect(compare(spec, buildCodeModel(spec, writes))).toEqual([]);
  });
});
