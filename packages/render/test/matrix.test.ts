import { orderModel } from "@tsverify/ir/testing";
import { permissionMatrix, permissionMatrixMarkdown } from "@tsverify/render";
import { describe, expect, it } from "vitest";
import { ownerOrAdminModel } from "./models";

describe("permissionMatrix", () => {
  it("builds the Order matrix", async () => {
    const m = permissionMatrix(orderModel());
    expect(m.actors).toEqual(["admin", "customer", "stripe", "system"]);
    expect(m.untrusted).toEqual(["customer"]);
    expect(m.cells.admin?.refund).toEqual({ allowed: true, guards: ["role(admin)"] });
    expect(m.cells.customer?.refund).toEqual({ allowed: false, guards: [] });
    await expect(`${JSON.stringify(m, null, 2)}\n`).toMatchFileSnapshot(
      "__golden__/order-matrix.json",
    );
  });

  it("merges transition and actor guards, deduplicated and sorted", () => {
    const model = orderModel();
    const refund = model.transitions.find((t) => t.name === "refund");
    if (!refund) throw new Error("fixture changed");
    refund.requires = [
      { name: "role", args: ["admin"], raw: "role(admin)" },
      { name: "mfa", args: [], raw: "mfa" },
    ];
    expect(permissionMatrix(model).cells.admin?.refund?.guards).toEqual(["mfa", "role(admin)"]);
  });

  it("gives each alternative actor in by its own guards plus the transition's", async () => {
    const model = ownerOrAdminModel();
    const m = permissionMatrix(model);
    expect(m.cells.customer?.refund).toEqual({ allowed: true, guards: ["owner", "verified"] });
    expect(m.cells.admin?.refund).toEqual({ allowed: true, guards: ["role(admin)", "verified"] });
    await expect(permissionMatrixMarkdown(model)).toMatchFileSnapshot(
      "__golden__/owner-or-admin-matrix.md",
    );
  });

  it("adds actors that are only named in a transition", () => {
    const model = orderModel();
    model.transitions[0]?.by.push("anonymous");
    expect(permissionMatrix(model).actors).toEqual([
      "admin",
      "anonymous",
      "customer",
      "stripe",
      "system",
    ]);
  });
});

describe("permissionMatrixMarkdown", () => {
  it("renders the Order matrix", async () => {
    const md = permissionMatrixMarkdown(orderModel());
    expect(md).toContain("| customer ⚠ untrusted | ✓ owner |");
    expect(md).not.toContain("unguarded");
    await expect(md).toMatchFileSnapshot("__golden__/order-matrix.md");
  });

  it("flags an unguarded transition of an untrusted actor", () => {
    const model = orderModel();
    const checkout = model.transitions.find((t) => t.name === "checkout");
    if (!checkout) throw new Error("fixture changed");
    checkout.requires = [];
    const md = permissionMatrixMarkdown(model);
    expect(md).toContain("| customer ⚠ untrusted | **✓ ⚠ unguarded** |");
    expect(md).toContain("**⚠ unguarded**: an untrusted actor");
  });

  it("escapes pipes in cells", () => {
    const model = orderModel();
    const checkout = model.transitions.find((t) => t.name === "checkout");
    if (!checkout) throw new Error("fixture changed");
    checkout.requires = [{ name: "any", args: ["a|b"], raw: "any(a|b)" }];
    expect(permissionMatrixMarkdown(model)).toContain("✓ any(a\\|b)");
  });
});
