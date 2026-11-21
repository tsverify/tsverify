/**
 * The seeded bugs are real: plain tests against each materialized variant show the misbehavior
 * the clean app's tests rule out. No scheduler is needed; the fake clients' simulated latency is
 * enough for `Promise.all` to interleave.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/actor";
import type { Order } from "../src/orders/order";
import type { Refund } from "../src/payments/stripe";
import { type MaterializedApp, materialize } from "./materialize";
import { admin, alice } from "./seed";

type Db = typeof import("../src/db");
type Email = typeof import("../src/notify/email");
type Stripe = typeof import("../src/payments/stripe");
type Webhook = typeof import("../src/payments/webhook");
type Jobs = typeof import("../src/jobs/expire-orders");
interface RefundModule {
  refundOrder(ctx: { actor: Actor; internal?: boolean }, orderId: string): Promise<Refund>;
}
interface AdminModule {
  reopenOrder(ctx: { actor: Actor }, orderId: string): Promise<Order>;
}

interface LoadedVariant {
  app: MaterializedApp;
  /** Imports a module of the materialized copy (its own instance, separate from `../src`). */
  module<T>(file: string): Promise<T>;
  db: Db["db"];
  stripeFake: Stripe["stripeFake"];
  emailFake: Email["emailFake"];
}

/** Materializes the variant for the enclosing `describe` and returns an accessor. */
function useVariant(id: string): () => LoadedVariant {
  let loaded: LoadedVariant | undefined;
  beforeAll(async () => {
    const app = await materialize(id);
    const module = <T>(file: string): Promise<T> => import(join(app.root, file));
    loaded = {
      app,
      module,
      db: (await module<Db>("src/db.ts")).db,
      stripeFake: (await module<Stripe>("src/payments/stripe.ts")).stripeFake,
      emailFake: (await module<Email>("src/notify/email.ts")).emailFake,
    };
  });
  afterAll(() => loaded?.app.dispose());
  return () => {
    if (!loaded) throw new Error(`${id} is not loaded`);
    return loaded;
  };
}

const ORDER_ID = "order-1";

function order(status: Order["status"], chargeId?: string): Order {
  return {
    id: ORDER_ID,
    ownerId: alice.id,
    email: "alice@example.com",
    status,
    ...(chargeId === undefined ? {} : { chargeId }),
  };
}

const payment = { id: "evt_1", orderId: ORDER_ID, chargeId: "ch_1" };

describe("b1-reopen", () => {
  const variant = useVariant("b1-reopen");

  it("a reopened order is paid again and sends a second receipt", async () => {
    const { db, emailFake, module } = variant();
    await db.orders.save(order("pending_payment"));
    const { onPaymentSucceeded } = await module<Webhook>("src/payments/webhook.ts");
    const { reopenOrder } = await module<AdminModule>("src/admin/orders.ts");

    await onPaymentSucceeded(payment);
    await reopenOrder({ actor: admin }, ORDER_ID);
    await onPaymentSucceeded(payment);

    expect(emailFake.sent()).toHaveLength(2);
  });
});

describe("b2-guard-bypass", () => {
  const variant = useVariant("b2-guard-bypass");

  it("a customer refunds a paid order by setting ctx.internal", async () => {
    const { db, stripeFake, module } = variant();
    await db.orders.save(order("paid", "ch_1"));
    const { refundOrder } = await module<RefundModule>("src/orders/refund.ts");

    await expect(refundOrder({ actor: alice }, ORDER_ID)).rejects.toThrow("not admin");
    await refundOrder({ actor: alice, internal: true }, ORDER_ID);

    expect((await db.orders.get(ORDER_ID)).status).toBe("refunded");
    expect(stripeFake.refunds()).toHaveLength(1);
  });
});

describe("b3-refund-race", () => {
  const variant = useVariant("b3-refund-race");

  it("two concurrent refunds both pass the check and call Stripe twice", async () => {
    const { db, stripeFake, module } = variant();
    await db.orders.save(order("paid", "ch_1"));
    const { refundOrder } = await module<RefundModule>("src/orders/refund.ts");

    await Promise.all([
      refundOrder({ actor: admin }, ORDER_ID),
      refundOrder({ actor: admin }, ORDER_ID),
    ]);

    expect(stripeFake.refunds()).toEqual([
      { id: "re_1", charge: "ch_1" },
      { id: "re_2", charge: "ch_1" },
    ]);
    expect((await db.orders.get(ORDER_ID)).status).toBe("refunded");
  });
});

describe("b4-webhook-dup", () => {
  const variant = useVariant("b4-webhook-dup");

  it("a duplicated payment webhook sends the receipt twice", async () => {
    const { db, emailFake, module } = variant();
    await db.orders.save(order("pending_payment"));
    const { onPaymentSucceeded } = await module<Webhook>("src/payments/webhook.ts");

    await Promise.all([onPaymentSucceeded(payment), onPaymentSucceeded(payment)]);

    expect(emailFake.sent()).toHaveLength(2);
    expect((await db.orders.get(ORDER_ID)).status).toBe("paid");
  });
});

describe("b5-undeclared-effect", () => {
  const variant = useVariant("b5-undeclared-effect");

  it("expiring an order that has a charge calls Stripe", async () => {
    const { db, stripeFake, module } = variant();
    await db.orders.save(order("pending_payment", "ch_1"));
    const { expireOrder } = await module<Jobs>("src/jobs/expire-orders.ts");

    expect(await expireOrder(ORDER_ID)).toBe(true);

    expect(stripeFake.refunds()).toEqual([{ id: "re_1", charge: "ch_1" }]);
  });
});
