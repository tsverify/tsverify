// The app is ordinary code: it runs without the runtime or any mocks.
import { describe, expect, test, vi } from "vitest";
import { db } from "../app/db";
import * as buggy from "../app/refund-buggy";
import * as fixed from "../app/refund-fixed";
import { stripe } from "../app/stripe";

const order = (id: string) => ({ id, status: "paid" as const, chargeId: `ch_${id}`, amount: 100 });

describe("app without instrumentation", () => {
  test("sequential refunds: the second one is rejected (both variants)", async () => {
    for (const [id, impl] of [
      ["a", buggy],
      ["b", fixed],
    ] as const) {
      await db.orders.save(order(id));
      expect(await impl.refundOrder(id)).toMatchObject({ refunded: true });
      expect(await impl.refundOrder(id)).toEqual({
        refunded: false,
        reason: "order is refunded",
      });
    }
  });

  test("fixed: the real transaction mutex serialises concurrent refunds", async () => {
    const create = vi.spyOn(stripe.refunds, "create");
    await db.orders.save(order("c"));
    const results = await Promise.all([fixed.refundOrder("c"), fixed.refundOrder("c")]);
    expect(results.filter((r) => r.refunded)).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    create.mockRestore();
  });
});
