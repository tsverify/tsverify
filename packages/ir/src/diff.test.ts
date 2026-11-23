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
    expect(added.entity.map((f) => f.field)).toEqual(["behavior", "name", "state", "initial"]);
    expect(diffModels(orderModel(), undefined).kind).toBe("removed");
    expect(() => diffModels(undefined, undefined)).toThrow();
  });

  it("reports a renamed behavior and a changed enforced flag", () => {
    const head = edited((m) => {
      m.name = "Orders";
      m.enforced = true;
    });
    const d = diffModels(orderModel(), head);
    expect(d.behavior).toBe("Orders");
    expect(d.kind).toBe("changed");
    expect(d.entity).toEqual([
      { field: "behavior", base: "Order lifecycle", head: "Orders" },
      { field: "enforced", base: "", head: "yes" },
    ]);
  });

  describe("named storage functions", () => {
    const repo = (symbol: string) => ({ file: "src/orders/repo.ts", symbol });
    function withStorage(m: BehaviorModel): void {
      m.bindings.storage = {
        key: "id",
        read: [{ ref: repo("getOrder"), args: ["key"] }],
        save: [{ ref: repo("saveOrder"), args: ["entity"] }],
        update: [{ ref: repo("setStatusIf"), args: ["key", "from", "to"] }],
        atomic: [{ ref: { file: "src/db.ts", symbol: "withTransaction" }, args: ["callback"] }],
        at: { file: "x.yaml", line: 1, column: 1 },
      };
    }

    it("lists every storage field of an added storage block, ignoring locations", () => {
      expect(diffModels(orderModel(), edited(withStorage)).bindings).toEqual([
        { field: "storage:atomic", base: "", head: "src/db.ts#withTransaction" },
        { field: "storage:key", base: "", head: "id" },
        { field: "storage:read", base: "", head: "src/orders/repo.ts#getOrder" },
        { field: "storage:save", base: "", head: "src/orders/repo.ts#saveOrder" },
        { field: "storage:update", base: "", head: "src/orders/repo.ts#setStatusIf" },
      ]);
      expect(diffModels(edited(withStorage), edited(withStorage)).kind).toBe("unchanged");
    });

    it("shows non-default roles, fixed states and returns, sorted", () => {
      const head = edited((m) => {
        withStorage(m);
        const storage = m.bindings.storage;
        if (!storage) throw new Error("fixture");
        storage.key = "orderId";
        storage.read.push({ ref: repo("findOrder"), args: ["_", "key"] });
        storage.update = [
          { ref: repo("setStatusIf"), args: ["key", "from", "to"], returns: "changed" },
          { ref: repo("markPaid"), args: ["key"], from: ["pending"], to: "paid", returns: "count" },
        ];
      });
      const d = diffModels(edited(withStorage), head);
      expect(d.bindings).toEqual([
        { field: "storage:key", base: "id", head: "orderId" },
        {
          field: "storage:read",
          base: "src/orders/repo.ts#getOrder",
          head: "src/orders/repo.ts#findOrder(_, key), src/orders/repo.ts#getOrder",
        },
        {
          field: "storage:update",
          base: "src/orders/repo.ts#setStatusIf",
          head: "src/orders/repo.ts#markPaid from [pending] to paid returns count, src/orders/repo.ts#setStatusIf",
        },
      ]);
    });
  });

  it("says `any state` for a from-list of every state (a blind update's), in transitions and storage", () => {
    const head = edited((m) => {
      const expire = m.transitions.find((t) => t.name === "expire");
      if (!expire) throw new Error("fixture");
      expire.from = [...m.entity.states];
      m.bindings.storage = {
        key: "id",
        read: [],
        save: [],
        update: [
          {
            ref: { file: "src/orders/repo.ts", symbol: "expireOrder" },
            args: ["key"],
            from: [...m.entity.states],
            to: "cancelled",
          },
        ],
        atomic: [],
      };
    });
    const d = diffModels(orderModel(), head);
    expect(d.transitions[0]?.fields).toContainEqual({
      field: "from",
      base: "pending_payment",
      head: "any state",
    });
    expect(d.bindings).toContainEqual({
      field: "storage:update",
      base: "",
      head: "src/orders/repo.ts#expireOrder from any state to cancelled",
    });
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
