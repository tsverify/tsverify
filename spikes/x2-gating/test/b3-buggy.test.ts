// Shape of what testgen (M6) would emit for the B3 counterexample.
import { describe, expect, test, vi } from "vitest";
import { instrument, type Schedule, scheduler } from "../runtime/index";
import { fingerprint, paidOrder, RUNS } from "./fixtures";

// Created before the app is imported. vi.mock is hoisted above these lines, but its factory only
// runs when the app first imports ../app/db, i.e. at the dynamic import below.
const s = scheduler();
const db = instrument.store(s, { name: "db", collections: { orders: { key: "id" } } });
const stripe = instrument.effects(s, { name: "stripe", calls: ["refunds.create"] });

vi.mock("../app/db", () => ({ db: db.client }));
vi.mock("../app/stripe", () => ({ stripe: stripe.client }));

const { refundOrder } = await import("../app/refund-buggy");

/** Model-shaped: read, read, write, write. Stripe (transparent gate) fires on the way to save. */
const B3: Schedule = [
  ["w1", "db.orders.get"],
  ["w2", "db.orders.get"],
  ["w1", "db.orders.save"],
  ["w2", "db.orders.save"],
  ["w1", "until-done"],
  ["w2", "until-done"],
];

/** Fully explicit: every gate named, including the effect. */
const B3_EXPLICIT: Schedule = [
  ["w1", "db.orders.get"],
  ["w2", "db.orders.get"],
  ["w1", "stripe.refunds.create"],
  ["w1", "db.orders.save"],
  ["w2", "stripe.refunds.create"],
  ["w2", "db.orders.save"],
  ["w1", "until-done"],
  ["w2", "until-done"],
];

async function replay(schedule: Schedule) {
  s.reset();
  db.seed("orders", [paidOrder()]);
  s.spawn("w1", () => refundOrder("o1"));
  s.spawn("w2", () => refundOrder("o1"));
  await s.play(schedule);
  return fingerprint(s, db.rows("orders"), ["w1", "w2"]);
}

describe("B3 replay against refund-buggy", () => {
  test("read, read, write, write → Stripe refunded twice (bug confirmed)", async () => {
    const r = await replay(B3);
    expect(s.effects("stripe.refunds.create").map((e) => e.worker)).toEqual(["w1", "w2"]);
    expect(r.gates).toEqual([
      "w1:db.orders.get",
      "w2:db.orders.get",
      "w1:stripe.refunds.create",
      "w1:db.orders.save",
      "w2:stripe.refunds.create",
      "w2:db.orders.save",
    ]);
    expect(r.rows).toEqual([paidOrder("refunded")]);
    expect(r.outcomes).toEqual([
      { status: "done", value: { refunded: true, refundId: "refunds_create_fake_1" } },
      { status: "done", value: { refunded: true, refundId: "refunds_create_fake_2" } },
    ]);
  });

  test(`deterministic: ${RUNS}/${RUNS} runs identical (model-shaped schedule)`, async () => {
    const first = await replay(B3);
    let identical = 0;
    let doubleRefunds = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await replay(B3);
      if (JSON.stringify(r) === JSON.stringify(first)) identical++;
      if (s.effects("stripe.refunds.create").length === 2) doubleRefunds++;
    }
    expect({ identical, doubleRefunds }).toEqual({ identical: RUNS, doubleRefunds: RUNS });
  });

  test(`deterministic: ${RUNS}/${RUNS} runs identical (explicit schedule), same result`, async () => {
    const modelShaped = await replay(B3);
    let identical = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await replay(B3_EXPLICIT);
      if (JSON.stringify(r) === JSON.stringify(modelShaped)) identical++;
    }
    expect(identical).toBe(RUNS);
  });

  test("the sequential schedule (w1 to completion, then w2) refunds once", async () => {
    const r = await replay([
      ["w1", "until-done"],
      ["w2", "until-done"],
    ]);
    expect(s.effects("stripe.refunds.create")).toHaveLength(1);
    expect(r.outcomes[1]).toEqual({
      status: "done",
      value: { refunded: false, reason: "order is refunded" },
    });
  });
});
