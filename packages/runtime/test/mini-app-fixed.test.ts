// B3 against the transactional mini-app refund: the code is safer than the trace.
import { describe, expect, test, vi } from "vitest";
import { replayResult, type Schedule, scheduler } from "../src/index";
import { miniAppFakes } from "./mini-app/fakes";
import { fingerprint, gateTrail, paidOrder, RUNS } from "./replay-helpers";

const s = scheduler();
const { db, stripe } = miniAppFakes(s);

vi.mock("./mini-app/db", () => ({ db: db.client }));
vi.mock("./mini-app/stripe", () => ({ stripe: stripe.client }));

const { refundOrder } = await import("./mini-app/refund-fixed");

/** The B3 counterexample, unchanged (as generated from the buggy model). */
const B3: Schedule = [
  ["w1", "db.orders.get"],
  ["w2", "db.orders.get"],
  ["w1", "db.orders.save"],
  ["w2", "db.orders.save"],
  ["w1", "until-done"],
  ["w2", "until-done"],
];

/**
 * B3 adapted to the transaction: w2 is sent into `db.transaction` (a transparent gate, named
 * explicitly) after w1's read, so it blocks on the lock. The closest legal interleaving to
 * "read, read".
 */
const B3_ADAPTED: Schedule = [
  ["w1", "db.orders.get"],
  ["w2", "db.transaction"], // w2 now waits for the lock held by w1
  ["w1", "db.orders.save"], // w1 commits; w2 becomes ready (holds the lock, not resumed)
  ["w2", "db.orders.get"], // w2 reads `refunded` and backs out
  ["w1", "until-done"], // w1 calls Stripe
  ["w2", "until-done"],
];

function setup() {
  s.reset();
  db.seed({ orders: [paidOrder()] });
  s.spawn("w1", () => refundOrder("o1"));
  s.spawn("w2", () => refundOrder("o1"));
}

describe("B3 replay against the transactional mini-app refund", () => {
  test("the adapted schedule is followed and Stripe is called once", async () => {
    setup();
    await s.play(B3_ADAPTED);
    expect(gateTrail(s)).toEqual([
      "w1:db.transaction",
      "w1:db.orders.get",
      "w2:db.transaction",
      "w1:db.orders.save",
      "w2:db.orders.get",
      "w1:stripe.refunds.create",
    ]);
    expect(stripe.calls("refunds.create").map((e) => e.worker)).toEqual(["w1"]);
    expect(s.outcome("w2")).toEqual({
      status: "done",
      value: { refunded: false, reason: "order is refunded" },
    });
  });

  test(`adapted schedule: ${RUNS}/${RUNS} runs identical, Stripe called once`, async () => {
    const results = new Set<string>();
    let once = 0;
    for (let i = 0; i < RUNS; i++) {
      setup();
      await s.play(B3_ADAPTED);
      if (stripe.calls("refunds.create").length === 1) once++;
      results.add(JSON.stringify(fingerprint(s, db.rows("orders"), ["w1", "w2"])));
    }
    expect(once).toBe(RUNS);
    expect(results.size).toBe(1);
  });

  test("the unadapted schedule diverges precisely: w2 is blocked by the transaction", async () => {
    setup();
    const outcome = await s.tryPlay(B3);
    expect(outcome.followed).toBe(false);
    if (outcome.followed) return;
    expect(outcome.divergence.details).toMatchObject({
      kind: "blocked",
      stepIndex: 1,
      worker: "w2",
      expected: "db.orders.get",
      actual: '"db.transaction"',
    });
    expect(outcome.divergence.message).toMatchInlineSnapshot(`
      "Replay diverged at step 2/6 ["w2", "db.orders.get"]: blocked
        w2 is waiting for "db.transaction" held by w1 (parked at "db.orders.save") and cannot reach "db.orders.get" until w1 releases it. The code serialises these workers more strictly than the schedule assumes.
      Workers:
        w1  parked at "db.orders.save"   passed: db.transaction → db.orders.get
        w2  waiting for "db.transaction" (held by w1)   passed: db.transaction
      Completed steps:
        1. ["w1", "db.orders.get"]"
    `);
  });

  test(`replay-disagrees: diverge, drain, property holds (${RUNS}/${RUNS})`, async () => {
    // What a generated replay does when the code is safer than the trace: keep the divergence,
    // drain the remaining workers in a fixed order, then evaluate the property anyway.
    const results = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      setup();
      const outcome = await s.tryPlay(B3);
      await s.drain();
      const refunds = stripe.calls("refunds.create").length;
      const { verdict, divergence } = replayResult(outcome, refunds > 1);
      results.add(
        JSON.stringify({ verdict, kind: divergence?.kind, refunds, gates: gateTrail(s) }),
      );
    }
    expect([...results].map((r) => JSON.parse(r))).toEqual([
      {
        verdict: "replay-disagrees",
        kind: "blocked",
        refunds: 1,
        gates: [
          "w1:db.transaction",
          "w1:db.orders.get",
          "w2:db.transaction",
          "w1:db.orders.save",
          "w1:stripe.refunds.create",
          "w2:db.orders.get",
        ],
      },
    ]);
  });
});
