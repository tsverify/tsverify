// A replay that silently diverges is worse than useless: every way off the schedule is an error.
import { afterEach, describe, expect, test, vi } from "vitest";
import { ReplayDivergence, type Schedule, scheduler } from "../src/index";
import { miniAppFakes } from "./mini-app/fakes";
import { gateTrail, paidOrder, RUNS } from "./replay-helpers";

const s = scheduler({ stepTimeoutMs: 200 });
const { db, stripe } = miniAppFakes(s);

vi.mock("./mini-app/db", () => ({ db: db.client }));
vi.mock("./mini-app/stripe", () => ({ stripe: stripe.client }));

const { refundOrder } = await import("./mini-app/refund-buggy");

function setup(status = "paid", workers: Record<string, () => unknown> = {}) {
  s.reset();
  db.seed({ orders: [paidOrder(status)] });
  for (const [id, fn] of Object.entries(workers)) s.spawn(id, fn);
}

async function divergence(schedule: Schedule): Promise<ReplayDivergence> {
  const outcome = await s.tryPlay(schedule);
  if (outcome.followed) throw new Error("expected the schedule to diverge");
  return outcome.divergence;
}

describe("every way a schedule cannot be followed", () => {
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
    expect(d.cause).toBe(d.details.cause);
  });

  test("invalid-schedule: unknown gate (typo) and unknown worker, rejected before running", async () => {
    setup("paid", { w1: () => refundOrder("o1") });
    const typo = await divergence([
      ["w1", "db.orders.get"],
      ["w1", "db.order.save"],
    ]);
    expect(typo.details).toMatchObject({ kind: "invalid-schedule", stepIndex: 1 });
    expect(typo.message).toContain('no instrumented client defines gate "db.order.save"');
    expect(typo.message).toContain(
      "Known gates: db.orders.get, db.orders.save, db.transaction, stripe.refunds.create.",
    );
    expect(s.gateLog()).toEqual([]); // nothing ran

    const ghost = await divergence([["w3", "until-done"]]);
    expect(ghost.message).toContain('no worker "w3" was spawned (spawned: w1)');
  });

  test("timeout: the worker awaits something the scheduler does not control", async () => {
    setup("paid", {
      w1: async () => {
        await db.client.orders.get("o1");
        await new Promise(() => {}); // e.g. an uninstrumented client
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
    expect(d.message).not.toContain("Fake timers are installed");
  });

  test("deadlock: a worker waits on a lock it already holds (nested transaction)", async () => {
    setup("paid", {
      w1: () => db.client.transaction(() => db.client.transaction(async () => "inner")),
    });
    const d = await divergence([["w1", "until-done"]]);
    expect(d.details).toMatchObject({ kind: "deadlock", actual: '"db.transaction"' });
    expect(d.message).toContain("wait-for cycle: w1 → w1.");
  });

  test("deadlock: a two-worker wait-for cycle across two stores", async () => {
    const s2 = scheduler();
    const a = miniAppFakes(s2).db;
    const { instrument } = await import("../src/index");
    const b = instrument.store(s2, {
      client: "ledger",
      collections: { entries: { key: "id" } },
      read: ["entries.get"],
      commit: ["entries.save"],
      transaction: "transaction",
    });
    s2.spawn("x", () => a.client.transaction(() => b.client.transaction(async () => 1)));
    s2.spawn("y", () => b.client.transaction(() => a.client.transaction(async () => 2)));
    const outcome = await s2.tryPlay([
      ["x", "db.transaction"], // x holds db, parks at ledger.transaction
      ["y", "ledger.transaction"], // y holds ledger, parks at db.transaction
      ["x", "until-done"], // x waits for ledger (held by y)
    ]);
    expect(outcome.followed).toBe(false);
    if (outcome.followed) return;
    // Not a cycle yet: y is parked, not waiting. The step is blocked by y.
    expect(outcome.divergence.details).toMatchObject({ kind: "blocked", worker: "x" });
    const again = await s2.tryPlay([["y", "until-done"]]);
    if (again.followed) throw new Error("expected a deadlock");
    expect(again.divergence.details.kind).toBe("deadlock");
    expect(again.divergence.message).toContain("wait-for cycle: y → x → y.");
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

  test("stray-gate: the worker settles while one of its calls is parked (Promise.race)", async () => {
    setup("paid", {
      w1: () => Promise.race([db.client.orders.get("o1"), Promise.resolve("fast")]),
    });
    const d = await divergence([["w1", "until-done"]]);
    expect(d.details.kind).toBe("stray-gate");
    expect(d.message).toContain('w1 returned while it was parked at "db.orders.get"');
  });

  test("stray-gate: a call from a run that was reset is never let through", async () => {
    setup("paid", {
      w1: async () => {
        // Fire-and-forget work that outlives the worker (and its run).
        setTimeout(() => void db.client.orders.get("o1"), 20);
      },
    });
    await s.play([["w1", "until-done"]]);
    setup("paid", {
      w2: async () => {
        await new Promise((r) => setTimeout(r, 100)); // still running when w1's timer fires
        return "late";
      },
    });
    const d = await divergence([["w2", "until-done"]]);
    expect(d.details.kind).toBe("stray-gate");
    expect(d.message).toContain('w1 called "db.orders.get" after its run was reset');
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
  afterEach(() => {
    vi.useRealTimers();
  });

  test("calls outside any worker pass straight through (test setup, seeding)", async () => {
    setup();
    await db.client.orders.save(paidOrder("shipped"));
    expect(await db.client.orders.get("o1")).toEqual(paidOrder("shipped"));
    expect(await db.client.transaction(async (tx) => tx.orders.get("o1"))).toEqual(
      paidOrder("shipped"),
    );
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

  test(`microtasks, nextTick, setImmediate and ungated concurrency between gates: ${RUNS}/${RUNS}`, async () => {
    const noisy = async (tag: string) => {
      const order = await db.client.orders.get("o1");
      await Promise.all([
        Promise.resolve(),
        new Promise((r) => process.nextTick(r)),
        new Promise((r) => queueMicrotask(() => r(undefined))),
        new Promise((r) => setImmediate(r)),
      ]);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await stripe.client.refunds.create({ charge: tag });
      await new Promise((r) => setImmediate(r));
      await db.client.orders.save({ ...order, status: `refunded-by-${tag}` });
      return tag;
    };
    const runs = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      setup("paid", { w1: () => noisy("w1"), w2: () => noisy("w2") });
      await s.play([
        ["w2", "db.orders.get"],
        ["w1", "db.orders.get"],
        ["w1", "db.orders.save"],
        ["w2", "db.orders.save"],
      ]);
      runs.add(JSON.stringify({ gates: gateTrail(s), rows: db.rows("orders") }));
    }
    expect([...runs].map((r) => JSON.parse(r))).toEqual([
      {
        gates: [
          "w2:db.orders.get",
          "w1:db.orders.get",
          "w1:stripe.refunds.create",
          "w1:db.orders.save",
          "w2:stripe.refunds.create",
          "w2:db.orders.save",
        ],
        rows: [{ ...paidOrder(), status: "refunded-by-w2" }],
      },
    ]);
  });

  test("fake timers do not disable the step timeout, and the message says why", async () => {
    setup("paid", {
      w1: async () => {
        await new Promise((r) => setTimeout(r, 10)); // faked: never fires
        return db.client.orders.get("o1");
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const d = await divergence([["w1", "until-done"]]);
    expect(d.details.kind).toBe("timeout");
    expect(d.message).toContain("Fake timers are installed (vi.useFakeTimers)");
  });
});
