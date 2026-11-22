/**
 * The clean Prisma app behaves as its spec says, against the in-memory stand-in client (no
 * database): happy paths, guards, rejected transitions, and the races the conditional updates
 * rule out. The stand-in's simulated latency is enough for `Promise.all` to interleave.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { shipOrder } from "../src/admin/orders";
import { ConcurrentUpdateError, ForbiddenError, InvalidTransitionError } from "../src/errors";
import { expireOrder } from "../src/jobs/expire-orders";
import { emailFake } from "../src/notify/email";
import { checkout } from "../src/orders/checkout";
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
    await onPaymentSucceeded(paymentFor(id));
    expect(await statusOf(id)).toBe("paid");
    expect(emailFake.sent()).toEqual([{ to: "alice@example.com", template: "receipt" }]);
    expect((await shipOrder({ actor: admin }, id)).status).toBe("shipped");
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

  it("expire cancels an unpaid order, and does nothing once it is paid", async () => {
    const unpaid = await seedOrder("pending_payment");
    expect(await expireOrder(unpaid.id)).toBe(true);
    expect(await statusOf(unpaid.id)).toBe("cancelled");
    const paid = await seedOrder("paid");
    expect(await expireOrder(paid.id)).toBe(false);
    expect(await statusOf(paid.id)).toBe("paid");
  });
});

describe("guards and rejected transitions", () => {
  it("only the owner checks out; only an admin ships or refunds", async () => {
    const draft = await seedOrder("draft");
    await expect(checkout({ actor: bob }, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    const paid = await seedOrder("paid");
    await expect(shipOrder({ actor: alice }, paid.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(refundOrder({ actor: alice }, paid.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await statusOf(paid.id)).toBe("paid");
  });

  it("refuses to refund or ship an order that is not paid", async () => {
    const { id } = await seedOrder("shipped");
    await expect(refundOrder({ actor: admin }, id)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(shipOrder({ actor: admin }, id)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(stripeFake.refunds()).toEqual([]);
  });

  it("a redelivered webhook is a no-op", async () => {
    const { id } = await seedOrder("pending_payment");
    await onPaymentSucceeded(paymentFor(id));
    await onPaymentSucceeded(paymentFor(id));
    expect(emailFake.sent()).toHaveLength(1);
  });
});

describe("concurrency: the conditional updates", () => {
  it("two concurrent refunds: one refunds at Stripe, the other loses the update", async () => {
    const { id } = await seedOrder("paid");
    const results = await Promise.allSettled([
      refundOrder({ actor: admin }, id),
      refundOrder({ actor: admin }, id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ConcurrentUpdateError);
    expect(stripeFake.refunds()).toHaveLength(1);
  });

  it("two concurrent deliveries of the same webhook send one receipt", async () => {
    const { id } = await seedOrder("pending_payment");
    await Promise.all([onPaymentSucceeded(paymentFor(id)), onPaymentSucceeded(paymentFor(id))]);
    expect(emailFake.sent()).toHaveLength(1);
  });
});
