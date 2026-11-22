// B3 against the spike's mini-app (non-atomic refund): the race must reproduce every time.
import { describe, expect, test, vi } from "vitest";
import { type Schedule, scheduler } from "../src/index";
import { miniAppFakes } from "./mini-app/fakes";
import { fingerprint, gateTrail, paidOrder, RUNS } from "./replay-helpers";

// Fakes first, as plain consts. vi.mock is hoisted above them, but its factory only runs when the
// app first imports ./mini-app/db, i.e. at the dynamic import below.
const s = scheduler();
const { db, stripe } = miniAppFakes(s);

vi.mock("./mini-app/db", () => ({ db: db.client }));
vi.mock("./mini-app/stripe", () => ({ stripe: stripe.client }));

const { refundOrder } = await import("./mini-app/refund-buggy");

/** Model-shaped: read, read, write, write. Stripe (transparent) is passed on the way to save. */
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
  db.seed({ orders: [paidOrder()] });
  s.spawn("w1", () => refundOrder("o1"));
  s.spawn("w2", () => refundOrder("o1"));
  await s.play(schedule);
  return fingerprint(s, db.rows("orders"), ["w1", "w2"]);
}

describe("B3 replay against the non-atomic mini-app refund", () => {
  test("read, read, write, write → Stripe refunded twice (bug confirmed)", async () => {
    const r = await replay(B3);
    expect(stripe.calls("refunds.create").map((e) => e.worker)).toEqual(["w1", "w2"]);
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
    expect(stripe.calls("refunds.create")[0]?.args).toEqual([
      { charge: "ch_1", metadata: { note: "refund:o1:4200" } },
    ]);
  });

  test(`deterministic: ${RUNS}/${RUNS} runs identical (model-shaped schedule)`, async () => {
    const first = JSON.stringify(await replay(B3));
    let identical = 0;
    let doubleRefunds = 0;
    for (let i = 0; i < RUNS; i++) {
      if (JSON.stringify(await replay(B3)) === first) identical++;
      if (stripe.calls("refunds.create").length === 2) doubleRefunds++;
    }
    expect({ identical, doubleRefunds }).toEqual({ identical: RUNS, doubleRefunds: RUNS });
  });

  test(`the explicit schedule gives the same run, ${RUNS}/${RUNS}`, async () => {
    const modelShaped = JSON.stringify(await replay(B3));
    let identical = 0;
    for (let i = 0; i < RUNS; i++) {
      if (JSON.stringify(await replay(B3_EXPLICIT)) === modelShaped) identical++;
    }
    expect(identical).toBe(RUNS);
  });

  test("the sequential schedule (w1 to completion, then w2) refunds once", async () => {
    const r = await replay([
      ["w1", "until-done"],
      ["w2", "until-done"],
    ]);
    expect(gateTrail(s)).toEqual([
      "w1:db.orders.get",
      "w1:stripe.refunds.create",
      "w1:db.orders.save",
      "w2:db.orders.get",
    ]);
    expect(stripe.calls("refunds.create")).toHaveLength(1);
    expect(r.outcomes[1]).toEqual({
      status: "done",
      value: { refunded: false, reason: "order is refunded" },
    });
  });
});
