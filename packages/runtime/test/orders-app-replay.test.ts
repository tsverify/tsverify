// Replay of the checker's double-refund counterexample against the REAL demo app code
// (examples/orders-app): its db and Stripe client modules are replaced by instrumented fakes,
// everything else (guards, errors, the refund implementations) runs unmodified.
//
// - The clean app refunds inside `db.transaction`: the code is safer than the trace, so the
//   replay is `blocked` by the transaction and the verdict is `replay-disagrees`.
// - The B3 variant reads, calls Stripe, then writes outside a transaction: the replay follows
//   the trace and Stripe refunds twice (`confirmed`).
//
// The B3 overlay (`examples/orders-app/variants/b3-refund-race/src/orders/refund.ts`) imports
// `../db`, `../payments/stripe`, …, which only resolve once the overlay is applied to a copy of
// the app. `fixtures/b3-refund-race/refund.ts` is that file with its imports pointed at the
// app's real modules; the drift test below keeps the two identical otherwise.
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { Actor } from "../../../examples/orders-app/src/auth/actor";
import { NotFoundError } from "../../../examples/orders-app/src/errors";
import {
  effectsConfigFromCode,
  instrument,
  mappingFromCode,
  planFromTrace,
  replayResult,
  scheduler,
  storeConfigFromCode,
} from "../src/index";
import { ordersAppCode, refundRaceTrace } from "./goldens";
import { gateTrail, RUNS } from "./replay-helpers";

// (1) Fakes, configured from the extractor's CodeSites, as plain top-level consts.
const s = scheduler();
const db = instrument.store(s, {
  ...storeConfigFromCode(ordersAppCode, "db"),
  missing: (_collection, id) => new NotFoundError(`order ${id} not found`), // like the real db
});
const stripe = instrument.effects(s, {
  ...effectsConfigFromCode(ordersAppCode, "stripe"),
  returns: {
    "refunds.create": (args, n) => ({
      id: `re_${n}`,
      charge: (args[0] as { charge: string }).charge,
    }),
  },
});

// (2) Mock the modules that construct the clients (Bindings.clients), relative to this file.
vi.mock("../../../examples/orders-app/src/db", () => ({ db: db.client }));
vi.mock("../../../examples/orders-app/src/payments/stripe", () => ({ stripe: stripe.client }));

// (3) The code under test, imported dynamically after (1).
const clean = await import("../../../examples/orders-app/src/orders/refund");
const b3 = await import("./fixtures/b3-refund-race/refund");

type RefundOrder = typeof clean.refundOrder;

const plan = planFromTrace(refundRaceTrace, mappingFromCode(ordersAppCode));
const admin: Actor = { id: "admin_1", roles: ["admin"] };

/** The seed: the entity row in `plan.seedStatus`, plus the fixture fields the code needs. */
function order(status: string) {
  return { id: "o1", ownerId: "u1", email: "u1@example.com", status, chargeId: "ch_1" };
}

async function replay(refundOrder: RefundOrder, actor: Actor = admin) {
  s.reset();
  db.seed({ orders: [order(plan.seedStatus)] });
  // InvocationShape: actor at param 0 path ["actor"], entity id at param 1.
  for (const w of plan.workers) s.spawn(w.id, () => refundOrder({ actor }, "o1"));
  const outcome = await s.tryPlay(plan.schedule);
  await s.drain();
  // The violated property, in code terms: "Refund issued at most once per order".
  const refunds = stripe.calls("refunds.create").length;
  const { divergence, ...result } = replayResult(outcome, refunds > 1);
  return {
    ...result,
    divergence: divergence && { kind: divergence.kind, stepIndex: divergence.stepIndex },
    refunds: { actual: refunds, model: plan.expectedEffects["stripe.refunds.create"] },
    gates: gateTrail(s),
    outcomes: plan.workers.map((w) => {
      const o = s.outcome(w.id);
      return o.status === "failed" ? { status: o.status, error: String(o.error) } : o;
    }),
    rows: db.rows("orders"),
  };
}

describe("double refund (b6-refund-race trace) replayed against the real orders app", () => {
  test("the plan comes from the golden trace and CodeSites", () => {
    expect(plan.schedule).toEqual([
      ["refund#1", "db.orders.get"],
      ["refund#2", "db.orders.get"],
      ["refund#1", "db.orders.save"],
      ["refund#2", "db.orders.save"],
      ["refund#1", "until-done"],
      ["refund#2", "until-done"],
    ]);
  });

  test("B3 variant (non-atomic): confirmed, Stripe refunds twice", async () => {
    expect(await replay(b3.refundOrder)).toEqual({
      verdict: "confirmed",
      followed: true,
      violated: true,
      divergence: undefined,
      refunds: { actual: 2, model: 2 },
      gates: [
        "refund#1:db.orders.get",
        "refund#2:db.orders.get",
        "refund#1:stripe.refunds.create",
        "refund#1:db.orders.save",
        "refund#2:stripe.refunds.create",
        "refund#2:db.orders.save",
      ],
      outcomes: [
        { status: "done", value: { id: "re_1", charge: "ch_1" } },
        { status: "done", value: { id: "re_2", charge: "ch_1" } },
      ],
      rows: [order("refunded")],
    });
    expect(stripe.calls("refunds.create").map((c) => [c.worker, c.args])).toEqual([
      ["refund#1", [{ charge: "ch_1" }]],
      ["refund#2", [{ charge: "ch_1" }]],
    ]);
  });

  test("clean app (transaction): replay-disagrees, blocked by db.transaction, Stripe once", async () => {
    expect(await replay(clean.refundOrder)).toEqual({
      verdict: "replay-disagrees",
      followed: false,
      violated: false,
      divergence: { kind: "blocked", stepIndex: 1 },
      refunds: { actual: 1, model: 2 },
      gates: [
        "refund#1:db.transaction",
        "refund#1:db.orders.get",
        "refund#2:db.transaction",
        "refund#1:db.orders.save",
        "refund#1:stripe.refunds.create",
        "refund#2:db.orders.get",
      ],
      outcomes: [
        { status: "done", value: { id: "re_1", charge: "ch_1" } },
        {
          status: "failed",
          error: "InvalidTransitionError: cannot refund an order that is refunded",
        },
      ],
      rows: [order("refunded")],
    });
  });

  test("clean app: the divergence explains what the code serialises", async () => {
    s.reset();
    db.seed({ orders: [order("paid")] });
    for (const w of plan.workers) s.spawn(w.id, () => clean.refundOrder({ actor: admin }, "o1"));
    const outcome = await s.tryPlay(plan.schedule);
    if (outcome.followed) throw new Error("expected a divergence");
    expect(outcome.divergence.message).toMatchInlineSnapshot(`
      "Replay diverged at step 2/6 ["refund#2", "db.orders.get"]: blocked
        refund#2 is waiting for "db.transaction" held by refund#1 (parked at "db.orders.save") and cannot reach "db.orders.get" until refund#1 releases it. The code serialises these workers more strictly than the schedule assumes.
      Workers:
        refund#1  parked at "db.orders.save"   passed: db.transaction → db.orders.get
        refund#2  waiting for "db.transaction" (held by refund#1)   passed: db.transaction
      Completed steps:
        1. ["refund#1", "db.orders.get"]"
    `);
  });

  test(`deterministic: ${RUNS}/${RUNS} identical runs for each variant`, async () => {
    for (const impl of [b3.refundOrder, clean.refundOrder]) {
      const runs = new Set<string>();
      for (let i = 0; i < RUNS; i++) runs.add(JSON.stringify(await replay(impl)));
      expect(runs.size).toBe(1);
    }
  });

  test("the app's real guards run: a non-admin never reaches a gate", async () => {
    const r = await replay(b3.refundOrder, { id: "u1", roles: [] });
    expect(r).toMatchObject({
      verdict: "replay-disagrees",
      divergence: { kind: "threw", stepIndex: 0 },
      gates: [],
      outcomes: [
        { status: "failed", error: "ForbiddenError: u1 is not admin" },
        { status: "failed", error: "ForbiddenError: u1 is not admin" },
      ],
    });
  });

  test("the B3 fixture is the variant's overlay with only its imports re-pointed", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const variant = read(
      "../../../examples/orders-app/variants/b3-refund-race/src/orders/refund.ts",
    );
    const fixture = read("./fixtures/b3-refund-race/refund.ts").replaceAll(
      '"../../../../../examples/orders-app/src/',
      '"../',
    );
    expect(fixture).toBe(variant);
  });
});
