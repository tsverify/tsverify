/** What the emitters share: drivable transitions, fake configs and fixtures, from real models. */
import type { BehaviorModel } from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";
import { describe, expect, it } from "vitest";
import cleanCode from "../../extractor/test/__golden__/orders-app.code.json" with { type: "json" };
import { buildContext } from "../src/context";

const code = cleanCode as unknown as BehaviorModel;
const outDir = ".tsv/generated/order-lifecycle";

describe("buildContext on the clean orders app", () => {
  const { ctx, skipped } = buildContext({ spec: orderModel(), code, outDir });

  it("drives every linked transition", () => {
    expect(skipped).toEqual([]);
    expect([...(ctx?.linked.keys() ?? [])]).toEqual([
      "checkout",
      "expire",
      "payment_succeeded",
      "refund",
      "ship",
    ]);
  });

  it("acts as the first permitted actor with a fixture, or as nobody", () => {
    const linked = ctx?.linked;
    expect(linked?.get("refund")).toMatchObject({
      actor: "admin",
      takesActor: true,
      args: "{ actor: ACTORS.admin }, ID",
    });
    expect(linked?.get("checkout")).toMatchObject({ actor: "customer" });
    expect(linked?.get("expire")).toMatchObject({ takesActor: false, args: "ID" });
    // fixtures.args wins over the invocation shape.
    expect(linked?.get("payment_succeeded")?.args).toBe(
      '{ id: "evt_1", orderId: ID, chargeId: "ch_1" }',
    );
  });

  it("configures the fakes from every CodeSites entry", () => {
    expect(ctx?.storage).toEqual({ client: "db", collection: "orders", key: "id" });
    expect(ctx?.id).toBe("o1");
    expect(ctx?.stores).toEqual([
      {
        client: "db",
        collections: { orders: { key: "id" } },
        read: ["orders.get"],
        commit: ["orders.save"],
        transaction: "transaction",
      },
    ]);
    expect(ctx?.effects).toEqual([
      { client: "email", calls: ["send"] },
      { client: "stripe", calls: ["refunds.create"] },
    ]);
  });

  it("rejects models with the wrong origin (programmer error)", () => {
    expect(() => buildContext({ spec: code, code, outDir })).toThrow(/origin "code"/);
  });
});
