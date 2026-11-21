import { beforeEach, describe, expect, it } from "vitest";
import { shipOrder } from "../src/admin/orders";
import { InvalidTransitionError } from "../src/errors";
import { expireOrder } from "../src/jobs/expire-orders";
import { emailFake } from "../src/notify/email";
import { refundOrder } from "../src/orders/refund";
import { stripeFake } from "../src/payments/stripe";
import { onPaymentSucceeded } from "../src/payments/webhook";
import { admin, resetApp, seedOrder, statusOf } from "./seed";

beforeEach(resetApp);

describe("atomic transitions under concurrency", () => {
  it("two concurrent refunds call Stripe exactly once", async () => {
    const { id } = await seedOrder("paid");

    const results = await Promise.allSettled([
      refundOrder({ actor: admin }, id),
      refundOrder({ actor: admin }, id),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(InvalidTransitionError);
    expect(stripeFake.refunds()).toHaveLength(1);
    expect(await statusOf(id)).toBe("refunded");
  });

  it("a duplicated payment webhook sends exactly one receipt", async () => {
    const { id } = await seedOrder("pending_payment");
    const event = { id: "evt_1", orderId: id, chargeId: "ch_1" };

    await Promise.all([onPaymentSucceeded(event), onPaymentSucceeded(event)]);

    expect(emailFake.sent()).toHaveLength(1);
    expect(await statusOf(id)).toBe("paid");
  });

  it("a redelivered webhook after the first one completed sends no second receipt", async () => {
    const { id } = await seedOrder("pending_payment");
    const event = { id: "evt_1", orderId: id, chargeId: "ch_1" };

    await onPaymentSucceeded(event);
    await onPaymentSucceeded(event);

    expect(emailFake.sent()).toHaveLength(1);
  });

  it("a payment that wins the race against expiry keeps the order paid", async () => {
    const { id } = await seedOrder("pending_payment");
    const event = { id: "evt_1", orderId: id, chargeId: "ch_1" };

    const [, expired] = await Promise.all([onPaymentSucceeded(event), expireOrder(id)]);

    expect(expired).toBe(false);
    expect(await statusOf(id)).toBe("paid");
    expect(emailFake.sent()).toHaveLength(1);
  });

  it("an expiry that wins the race against a late payment sends no receipt", async () => {
    const { id } = await seedOrder("pending_payment");
    const event = { id: "evt_1", orderId: id, chargeId: "ch_1" };

    const [expired] = await Promise.all([expireOrder(id), onPaymentSucceeded(event)]);

    expect(expired).toBe(true);
    expect(await statusOf(id)).toBe("cancelled");
    expect(emailFake.sent()).toEqual([]);
  });

  it("ship racing refund lets exactly one through, so a shipped order is never refunded", async () => {
    const { id } = await seedOrder("paid");

    const results = await Promise.allSettled([
      shipOrder({ actor: admin }, id),
      refundOrder({ actor: admin }, id),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(await statusOf(id)).toBe("shipped");
    expect(stripeFake.refunds()).toEqual([]);
  });
});
