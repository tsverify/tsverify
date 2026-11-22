// An executable example of the replay test `tsverify` should generate (README "Shape of a generated
// replay test"), against the real orders app. A generated test FAILS when the bug is confirmed;
// the B3 case here asserts that the generated assertion throws, so CI stays green.
import { expect, test, vi } from "vitest";
import trace from "../../checker/test/__golden__/b6-refund-race.trace.json" with { type: "json" };
import code from "../../extractor/test/__golden__/orders-app.code.json" with { type: "json" };
import {
  instrument,
  mappingFromCode,
  planFromTrace,
  type ReplayResult,
  replayResult,
  scheduler,
} from "../src/index";

declare module "vitest" {
  interface TaskMeta {
    tsverifyReplay?: ReplayResult;
  }
}

// (1) Fakes as plain top-level consts.
const s = scheduler();
const db = instrument.store(s, {
  client: "db",
  collections: { orders: { key: "id" } },
  read: ["orders.get"],
  commit: ["orders.save"],
  transaction: "transaction",
});
const stripe = instrument.effects(s, { client: "stripe", calls: ["refunds.create"] });

// (2) The modules that construct the clients (Bindings.clients), relative to this file.
vi.mock("../../../examples/orders-app/src/db", () => ({ db: db.client }));
vi.mock("../../../examples/orders-app/src/payments/stripe", () => ({ stripe: stripe.client }));

// (3) The impls, imported dynamically after (1).
const clean = await import("../../../examples/orders-app/src/orders/refund");
const b3 = await import("./fixtures/b3-refund-race/refund");

const plan = planFromTrace(trace, mappingFromCode(code));
// trace steps 1-2 (checkout#1, payment_succeeded#1) fast-forwarded: seed status "paid"
// [refund#1, db.orders.get]   step 3  refund#1 read
// [refund#2, db.orders.get]   step 4  refund#2 read
// [refund#1, db.orders.save]  step 5  refund#1 write
// [refund#2, db.orders.save]  step 6  refund#2 write

async function replayRefundRace(refundOrder: typeof clean.refundOrder): Promise<ReplayResult> {
  s.reset();
  db.seed({
    orders: [
      {
        id: "order_1",
        ownerId: "user_1",
        email: "user_1@example.test",
        status: plan.seedStatus,
        chargeId: "ch_1",
      },
    ],
  });
  const actor = { id: "admin_1", roles: ["admin"] as const }; // actor `admin`: requires role(admin)
  for (const w of plan.workers) s.spawn(w.id, () => refundOrder({ actor }, "order_1"));
  const outcome = await s.tryPlay(plan.schedule);
  await s.drain();
  // rule "Refund issued at most once per order": count(effect stripe.refund) <= 1
  const refunds =
    (plan.seedEffects["stripe.refunds.create"] ?? 0) + stripe.calls("refunds.create").length;
  return replayResult(outcome, !(refunds <= 1));
}

test("clean app: replay of 'Refund issued at most once per order' (replay-disagrees)", async ({
  task,
}) => {
  const result = await replayRefundRace(clean.refundOrder);
  task.meta.tsverifyReplay = result;
  expect(result.violated, `${result.verdict}\n${result.divergence?.message ?? ""}`).toBe(false);
  expect(task.meta.tsverifyReplay).toMatchObject({
    verdict: "replay-disagrees",
    divergence: { kind: "blocked", stepIndex: 1, worker: "refund#2" },
  });
});

test("B3 variant: the same generated assertion fails (confirmed)", async ({ task }) => {
  const result = await replayRefundRace(b3.refundOrder);
  task.meta.tsverifyReplay = result;
  expect(result).toEqual({ verdict: "confirmed", followed: true, violated: true });
  // The generated test's own assertion, which must fail for a confirmed bug:
  expect(() =>
    expect(result.violated, `${result.verdict}\n${result.divergence?.message ?? ""}`).toBe(false),
  ).toThrow(/^confirmed/);
});
