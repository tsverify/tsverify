import { describe, expect, it } from "vitest";
import { compareStrings } from "./compare";
import { diffModels } from "./diff";
import type { BehaviorModel } from "./model";
import { orderModel } from "./testing";

function edited(edit: (m: BehaviorModel) => void): BehaviorModel {
  const m = orderModel();
  edit(m);
  return m;
}

describe("diffModels", () => {
  it("reports nothing for identical models, ignoring locations", () => {
    const head = edited((m) => {
      m.entity.at = { file: "x.yaml", line: 1, column: 1 };
    });
    expect(diffModels(orderModel(), head)).toEqual({
      behavior: "Order lifecycle",
      kind: "unchanged",
      entity: [],
      states: [],
      transitions: [],
      actors: [],
      rules: [],
      bindings: [],
    });
  });

  it("reports changed transition fields in a fixed order", () => {
    const head = edited((m) => {
      const refund = m.transitions.find((t) => t.name === "refund");
      if (!refund) throw new Error("fixture");
      refund.atomic = !refund.atomic;
      refund.requires = [{ name: "kyc", args: [], raw: "kyc" }];
      m.concurrency.refund = 3;
    });
    const d = diffModels(orderModel(), head);
    expect(d.kind).toBe("changed");
    expect(d.transitions).toHaveLength(1);
    expect(d.transitions[0]?.name).toBe("refund");
    expect(d.transitions[0]?.kind).toBe("changed");
    expect(d.transitions[0]?.fields.map((f) => f.field)).toEqual([
      "requires",
      "atomic",
      "concurrency",
    ]);
    expect(d.transitions[0]?.fields.at(-1)).toMatchObject({ head: "3" });
  });

  it("lists added and removed items with their fields", () => {
    const base = orderModel();
    const head = edited((m) => {
      m.transitions = m.transitions.filter((t) => t.name !== "expire");
      m.entity.states.push("archived");
      m.entity.terminal.push("archived");
      m.rules = [];
    });
    const d = diffModels(base, head);
    expect(d.transitions).toEqual([expect.objectContaining({ kind: "removed", name: "expire" })]);
    expect(d.transitions[0]?.fields.every((f) => f.head === "")).toBe(true);
    expect(d.states).toEqual([
      { kind: "added", name: "archived", fields: [{ field: "terminal", base: "", head: "yes" }] },
    ]);
    expect(d.rules.map((r) => [r.kind, r.name])).toEqual(
      base.rules
        .map((r) => ["removed", r.name])
        .sort((a, b) => compareStrings(a[1] ?? "", b[1] ?? "")),
    );
  });

  it("treats a missing side as an added or removed behavior", () => {
    const added = diffModels(undefined, orderModel());
    expect(added.kind).toBe("added");
    expect(added.transitions.every((t) => t.kind === "added")).toBe(true);
    expect(added.entity.map((f) => f.field)).toEqual(["name", "state", "initial"]);
    expect(diffModels(orderModel(), undefined).kind).toBe("removed");
    expect(() => diffModels(undefined, undefined)).toThrow();
  });

  it("diffs bindings by key", () => {
    const head = edited((m) => {
      m.bindings.effects["stripe.refund"] = "stripe.refunds.createV2";
    });
    expect(diffModels(orderModel(), head).bindings).toEqual([
      {
        field: "effect:stripe.refund",
        base: orderModel().bindings.effects["stripe.refund"] ?? "",
        head: "stripe.refunds.createV2",
      },
    ]);
  });
});
