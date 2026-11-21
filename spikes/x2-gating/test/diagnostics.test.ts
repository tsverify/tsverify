// A replay that silently diverges is worse than useless: every way off the schedule is an error.
import { describe, expect, test, vi } from "vitest";
import { instrument, ReplayDivergence, type Schedule, scheduler } from "../runtime/index";
import { paidOrder } from "./fixtures";

const s = scheduler({ stepTimeoutMs: 200 });
const db = instrument.store(s, { name: "db", collections: { orders: { key: "id" } } });
const stripe = instrument.effects(s, { name: "stripe", calls: ["refunds.create"] });

vi.mock("../app/db", () => ({ db: db.client }));
vi.mock("../app/stripe", () => ({ stripe: stripe.client }));

const { refundOrder } = await import("../app/refund-buggy");

function setup(status = "paid", workers: Record<string, () => unknown> = {}) {
  s.reset();
  db.seed("orders", [paidOrder(status)]);
  for (const [id, fn] of Object.entries(workers)) s.spawn(id, fn);
}

async function divergence(schedule: Schedule): Promise<ReplayDivergence> {
  const outcome = await s.tryPlay(schedule);
  if (outcome.followed) throw new Error("expected the schedule to diverge");
  return outcome.divergence;
}

describe("schedule cannot be followed", () => {
  test("finished-early: the schedule names a gate the worker never reaches", async () => {
    // The order is already refunded, so the code returns after the read and never writes.
    setup("refunded", { w1: () => refundOrder("o1") });
    const d = await divergence([
      ["w1", "db.orders.get"],
      ["w1", "db.orders.save"],
    ]);
    expect(d.details).toMatchObject({
      kind: "finished-early",
      stepIndex: 1,
      worker: "w1",
      expected: "db.orders.save",
    });
    expect(d.message).toMatchInlineSnapshot(`
      "Replay diverged at step 2/2 ["w1", "db.orders.save"]: finished-early
        w1 returned {"refunded":false,"reason":"order is refunded"} without reaching "db.orders.save".
      Workers:
        w1  done → {"refunded":false,"reason":"order is refunded"}   passed: db.orders.get
      Completed steps:
        1. ["w1", "db.orders.get"]"
    `);
  });

  test("different-gate: the worker's next sync gate is not the one named", async () => {
    setup("paid", { w1: () => refundOrder("o1") });
    const d = await divergence([["w1", "db.orders.save"]]);
    expect(d.details).toMatchObject({
      kind: "different-gate",
      stepIndex: 0,
      expected: "db.orders.save",
      actual: "db.orders.get",
    });
    expect(d.message).toContain(
      'w1 reached sync gate "db.orders.get" but the schedule expects "db.orders.save" next.',
    );
  });

  test("threw: the worker throws before reaching the gate", async () => {
    setup("paid", { w1: () => refundOrder("missing") });
    const d = await divergence([
      ["w1", "db.orders.get"],
      ["w1", "db.orders.save"],
    ]);
    expect(d.details).toMatchObject({
      kind: "threw",
      stepIndex: 1,
      actual: "Error: order missing not found",
    });
    expect(d.details.cause).toBeInstanceOf(Error);
  });

  test("invalid-schedule: unknown gate (typo) and unknown worker are rejected before running", async () => {
    setup("paid", { w1: () => refundOrder("o1") });
    const typo = await divergence([
      ["w1", "db.orders.get"],
      ["w1", "db.order.save"],
    ]);
    expect(typo.details).toMatchObject({ kind: "invalid-schedule", stepIndex: 1 });
    expect(typo.message).toContain('no instrumented client defines gate "db.order.save"');
    expect(typo.message).toContain(
      "Known gates: db.transaction, db.orders.get, db.orders.save, stripe.refunds.create.",
    );
    expect(s.gateLog()).toEqual([]); // nothing ran

    const ghost = await divergence([["w3", "until-done"]]);
    expect(ghost.message).toContain('no worker "w3" was spawned (spawned: w1)');
  });

  test("timeout: the worker awaits something the scheduler does not control", async () => {
    setup("paid", {
      w1: async () => {
        await db.client.orders.get("o1");
        await new Promise(() => {}); // e.g. an uninstrumented client, or a fake timer never advanced
      },
    });
    const d = await divergence([
      ["w1", "db.orders.get"],
      ["w1", "until-done"],
    ]);
    // The first step times out: after passing the gate, w1 never parks again or settles.
    expect(d.details).toMatchObject({ kind: "timeout", stepIndex: 0 });
    expect(d.message).toContain(
      'w1 neither reached a gate nor settled within 200 ms after passing "db.orders.get".',
    );
  });

  test("deadlock: a worker waits on a lock it already holds (nested transaction)", async () => {
    setup("paid", {
      w1: () => db.client.transaction(() => db.client.transaction(async () => "inner")),
    });
    const d = await divergence([["w1", "until-done"]]);
    expect(d.details).toMatchObject({ kind: "deadlock", actual: '"db.transaction"' });
    expect(d.message).toContain("wait-for cycle: w1 → w1.");
  });

  test("deadlock while draining: only waiting workers remain", async () => {
    setup("paid", {
      w1: () => db.client.transaction(() => db.client.transaction(async () => "inner")),
    });
    await expect(s.drain()).rejects.toThrow(
      /while draining: deadlock\n.*every unfinished worker is waiting: w1 on "db.transaction"/,
    );
  });

  test("stray-gate: two gated calls in flight in one worker (Promise.all)", async () => {
    setup("paid", {
      w1: () => Promise.all([db.client.orders.get("o1"), db.client.orders.get("o1")]),
    });
    const d = await divergence([["w1", "db.orders.get"]]);
    expect(d.details).toMatchObject({ kind: "stray-gate", stepIndex: 0 });
    expect(d.message).toContain('w1 called "db.orders.get" while it was parked at "db.orders.get"');
  });

  test("play throws a ReplayDivergence (what a generated test relies on)", async () => {
    setup("paid", { w1: () => refundOrder("o1") });
    await expect(
      s.play([
        ["w1", "stripe.refunds.create"],
        ["w1", "db.orders.get"],
      ]),
    ).rejects.toThrow(ReplayDivergence);
  });
});

describe("noise the scheduler tolerates", () => {
  test("calls outside any worker pass straight through (test setup, seeding)", async () => {
    setup();
    await db.client.orders.save(paidOrder("shipped"));
    expect(await db.client.orders.get("o1")).toEqual(paidOrder("shipped"));
    expect(s.gateLog()).toEqual([]);
  });

  test("real timers inside the running worker are fine: the step waits for it to park", async () => {
    setup("paid", {
      w1: async () => {
        await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setImmediate(r));
        return db.client.orders.get("o1");
      },
    });
    await s.play([["w1", "until-done"]]);
    expect(s.outcome("w1")).toEqual({ status: "done", value: paidOrder() });
  });
});
