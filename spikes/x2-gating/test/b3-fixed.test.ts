import { describe, expect, test, vi } from "vitest";
import { instrument, type Schedule, scheduler } from "../runtime/index";
import { fingerprint, paidOrder, RUNS } from "./fixtures";

const s = scheduler();
const db = instrument.store(s, { name: "db", collections: { orders: { key: "id" } } });
const stripe = instrument.effects(s, { name: "stripe", calls: ["refunds.create"] });

vi.mock("../app/db", () => ({ db: db.client }));
vi.mock("../app/stripe", () => ({ stripe: stripe.client }));

const { refundOrder } = await import("../app/refund-fixed");

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
 * explicitly) after w1's read, so it blocks on the lock. That is the closest the fixed code can
 * get to "read, read".
 */
const B3_ADAPTED: Schedule = [
  ["w1", "db.orders.get"],
  ["w2", "db.transaction"], // w2 now waiting for the lock held by w1
  ["w1", "db.orders.save"], // w1 commits; w2 becomes ready (holds the lock, not resumed)
  ["w2", "db.orders.get"], // w2 reads `refunded` and backs out
  ["w1", "until-done"], // w1 calls Stripe
  ["w2", "until-done"],
];

function setup() {
  s.reset();
  db.seed("orders", [paidOrder()]);
  s.spawn("w1", () => refundOrder("o1"));
  s.spawn("w2", () => refundOrder("o1"));
}

describe("B3 replay against refund-fixed", () => {
  test("adapted schedule is followed and Stripe is called once", async () => {
    setup();
    await s.play(B3_ADAPTED);
    expect(s.gateLog().map((e) => `${e.worker}:${e.gate}`)).toEqual([
      "w1:db.transaction",
      "w1:db.orders.get",
      "w2:db.transaction",
      "w1:db.orders.save",
      "w2:db.orders.get",
      "w1:stripe.refunds.create",
    ]);
    expect(s.effects("stripe.refunds.create").map((e) => e.worker)).toEqual(["w1"]);
    expect(s.outcome("w2")).toEqual({
      status: "done",
      value: { refunded: false, reason: "order is refunded" },
    });
  });

  test(`adapted schedule: ${RUNS}/${RUNS} runs identical, Stripe called once`, async () => {
    const results: string[] = [];
    let once = 0;
    for (let i = 0; i < RUNS; i++) {
      setup();
      await s.play(B3_ADAPTED);
      if (s.effects("stripe.refunds.create").length === 1) once++;
      results.push(JSON.stringify(fingerprint(s, db.rows("orders"), ["w1", "w2"])));
    }
    expect(once).toBe(RUNS);
    expect(new Set(results).size).toBe(1);
  });

  test("unadapted B3 schedule diverges precisely: w2 is blocked by the transaction lock", async () => {
    setup();
    const outcome = await s.tryPlay(B3);
    expect(outcome.followed).toBe(false);
    if (outcome.followed) return;
    const d = outcome.divergence.details;
    expect(d).toMatchObject({
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
    // What a generated replay does when the code is safer than the trace: report the divergence,
    // drain the remaining workers in a fixed order, then evaluate the violated property anyway.
    const verdicts = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      setup();
      const outcome = await s.tryPlay(B3);
      await s.drain();
      const refunds = s.effects("stripe.refunds.create").length;
      verdicts.add(
        JSON.stringify({
          followed: outcome.followed,
          divergence: outcome.followed ? null : outcome.divergence.kind,
          violated: refunds > 1,
          refunds,
          gates: s.gateLog().map((e) => `${e.worker}:${e.gate}`),
        }),
      );
    }
    expect([...verdicts].map((v) => JSON.parse(v))).toEqual([
      {
        followed: false,
        divergence: "blocked",
        violated: false,
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
