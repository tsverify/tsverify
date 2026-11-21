import { beforeEach, describe, expect, it } from "vitest";
import { shipOrder } from "../src/admin/orders";
import { ForbiddenError, InvalidTransitionError } from "../src/errors";
import { expireOrder } from "../src/jobs/expire-orders";
import { emailFake } from "../src/notify/email";
import { checkout } from "../src/orders/checkout";
import type { OrderStatus } from "../src/orders/order";
import { refundOrder } from "../src/orders/refund";
import { stripeFake } from "../src/payments/stripe";
import { onPaymentSucceeded } from "../src/payments/webhook";
import { admin, alice, bob, resetApp, seedOrder, statusOf } from "./seed";

beforeEach(resetApp);

function paymentFor(orderId: string) {
  return { id: `evt_${orderId}`, orderId, chargeId: `ch_${orderId}` };
}

describe("happy paths", () => {
  it("checkout → payment_succeeded → ship", async () => {
    const { id } = await seedOrder("draft");

    expect((await checkout({ actor: alice }, id)).status).toBe("pending_payment");
    expect(await statusOf(id)).toBe("pending_payment");

    await onPaymentSucceeded(paymentFor(id));
    expect(await statusOf(id)).toBe("paid");
    expect(emailFake.sent()).toEqual([{ to: "alice@example.com", template: "receipt" }]);

    expect((await shipOrder({ actor: admin }, id)).status).toBe("shipped");
    expect(await statusOf(id)).toBe("shipped");
    expect(stripeFake.refunds()).toEqual([]);
  });

  it("payment_succeeded → refund refunds the charge the webhook recorded", async () => {
    const { id } = await seedOrder("pending_payment");
    await onPaymentSucceeded(paymentFor(id));

    const refund = await refundOrder({ actor: admin }, id);
    expect(refund.charge).toBe(`ch_${id}`);
    expect(await statusOf(id)).toBe("refunded");
    expect(stripeFake.refunds()).toEqual([refund]);
  });

  it("expire cancels an unpaid order", async () => {
    const { id } = await seedOrder("draft");
    await checkout({ actor: alice }, id);

    expect(await expireOrder(id)).toBe(true);
    expect(await statusOf(id)).toBe("cancelled");
    expect(emailFake.sent()).toEqual([]);
    expect(stripeFake.refunds()).toEqual([]);
  });
});

describe("guards", () => {
  it("only the owner can check out", async () => {
    const { id } = await seedOrder("draft");
    await expect(checkout({ actor: bob }, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(checkout({ actor: admin }, id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await statusOf(id)).toBe("draft");
  });

  it("only an admin can ship", async () => {
    const { id } = await seedOrder("paid");
    await expect(shipOrder({ actor: alice }, id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await statusOf(id)).toBe("paid");
  });

  it("only an admin can refund, and a denied refund calls Stripe zero times", async () => {
    const { id } = await seedOrder("paid");
    await expect(refundOrder({ actor: alice }, id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await statusOf(id)).toBe("paid");
    expect(stripeFake.refunds()).toEqual([]);
  });
});

describe("forbidden transitions", () => {
  const ALL: OrderStatus[] = [
    "draft",
    "pending_payment",
    "paid",
    "shipped",
    "refunded",
    "cancelled",
  ];
  const except = (...allowed: OrderStatus[]) => ALL.filter((s) => !allowed.includes(s));

  it.each(except("draft"))("checkout rejects a %s order", async (status) => {
    const { id } = await seedOrder(status);
    await expect(checkout({ actor: alice }, id)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await statusOf(id)).toBe(status);
  });

  it.each(except("paid"))("ship rejects a %s order", async (status) => {
    const { id } = await seedOrder(status);
    await expect(shipOrder({ actor: admin }, id)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await statusOf(id)).toBe(status);
  });

  it.each(except("paid"))("refund rejects a %s order without calling Stripe", async (status) => {
    const { id } = await seedOrder(status);
    await expect(refundOrder({ actor: admin }, id)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(await statusOf(id)).toBe(status);
    expect(stripeFake.refunds()).toEqual([]);
  });

  it.each(except("pending_payment"))(
    "payment_succeeded ignores a %s order and sends no receipt",
    async (status) => {
      const { id } = await seedOrder(status);
      await onPaymentSucceeded(paymentFor(id));
      expect(await statusOf(id)).toBe(status);
      expect(emailFake.sent()).toEqual([]);
    },
  );

  it.each(except("pending_payment"))("expire leaves a %s order alone", async (status) => {
    const { id } = await seedOrder(status);
    expect(await expireOrder(id)).toBe(false);
    expect(await statusOf(id)).toBe(status);
  });
});
