// planFromTrace driven by the checker's real counterexample and the extractor's real CodeSites.
// The B1 / B4 traces are real code-model counterexamples kept as testgen fixtures.
import { describe, expect, test } from "vitest";
import {
  effectsConfigFromCode,
  mappingFromCode,
  planFromTrace,
  type ReplayMapping,
  replayVerdict,
  storeConfigFromCode,
} from "../src/index";
import { b1ReopenTrace, b4WebhookDupTrace, ordersAppCode, refundRaceTrace } from "./goldens";

describe("mappingFromCode (orders-app CodeSites)", () => {
  test("model actions → sync gates; transactions and effects stay transparent", () => {
    const mapping = mappingFromCode(ordersAppCode);
    const gates = { read: ["db.orders.get"], write: ["db.orders.save"] };
    const each = { ...gates, atomic: [...gates.read, ...gates.write] };
    expect(mapping).toEqual({
      transitions: {
        checkout: each,
        expire: each,
        payment_succeeded: each,
        refund: each,
        ship: each,
      },
      effects: { "email.receipt": "email.send", "stripe.refund": "stripe.refunds.create" },
    });
    // The refund's sites the mapping is built from: read.gate, commit.gate, atomic.gate.
    const refund = ordersAppCode.transitions.find((t) => t.name === "refund")?.sites;
    expect([refund?.read?.gate, refund?.commit?.gate, refund?.atomic?.gate]).toEqual([
      "db.orders.get",
      "db.orders.save",
      "db.transaction",
    ]);
  });

  test("instrument configs from the same sites", () => {
    expect(storeConfigFromCode(ordersAppCode, "db")).toEqual({
      client: "db",
      collections: { orders: { key: "id" } },
      read: ["orders.get"],
      commit: ["orders.save"],
      transaction: "transaction",
    });
    expect(effectsConfigFromCode(ordersAppCode, "stripe")).toEqual({
      client: "stripe",
      calls: ["refunds.create"],
    });
    expect(effectsConfigFromCode(ordersAppCode, "email")).toEqual({
      client: "email",
      calls: ["send"],
    });
  });

  test("a repeated call before the relevant occurrence is listed once per occurrence", () => {
    const site = (path: string, occurrence: number) => ({
      client: "db",
      path,
      gate: `db.${path}`,
      occurrence,
    });
    const mapping = mappingFromCode({
      transitions: [
        {
          name: "merge",
          sites: {
            specTransition: "merge",
            read: site("orders.get", 1), // the entity read is the second get
            commit: site("orders.save", 0),
            effects: [],
          },
        },
        { name: "merge->cancelled", sites: { specTransition: "merge", effects: [] } },
        { name: "helperWrite", sites: { effects: [] } },
      ],
    });
    expect(mapping.transitions).toEqual({
      merge: {
        read: ["db.orders.get", "db.orders.get"],
        write: ["db.orders.save"],
        atomic: ["db.orders.get", "db.orders.get", "db.orders.save"],
      },
    });
  });
});

describe("planFromTrace (b6-refund-race)", () => {
  const mapping = mappingFromCode(ordersAppCode);

  test("prefix fast-forwarded by seeding `paid`, refund actions mapped to gates", () => {
    expect(planFromTrace(refundRaceTrace, mapping)).toEqual({
      property: "rule:Refund issued at most once per order",
      startIndex: 3,
      seedStatus: "paid",
      seedEffects: { "email.send": 1, "stripe.refunds.create": 0 }, // the receipt was sent in the prefix
      skipped: [
        { index: 1, worker: "checkout#1", transition: "checkout", kind: "atomic" },
        {
          index: 2,
          worker: "payment_succeeded#1",
          transition: "payment_succeeded",
          kind: "atomic",
        },
      ],
      workers: [
        { id: "refund#1", transition: "refund" },
        { id: "refund#2", transition: "refund" },
      ],
      schedule: [
        ["refund#1", "db.orders.get"],
        ["refund#2", "db.orders.get"],
        ["refund#1", "db.orders.save"],
        ["refund#2", "db.orders.save"],
        ["refund#1", "until-done"],
        ["refund#2", "until-done"],
      ],
      origins: [3, 4, 5, 6, -1, -1],
      expectedEffects: { "email.send": 0, "stripe.refunds.create": 2 },
    });
  });

  test("without fast-forward the whole trace is replayed (atomic actions: read then commit)", () => {
    const plan = planFromTrace(refundRaceTrace, mapping, { fastForward: false });
    expect(plan).toMatchObject({
      startIndex: 1,
      seedStatus: "draft",
      seedEffects: { "email.send": 0, "stripe.refunds.create": 0 },
      skipped: [],
    });
    expect(plan.schedule.slice(0, 4)).toEqual([
      ["checkout#1", "db.orders.get"],
      ["checkout#1", "db.orders.save"],
      ["payment_succeeded#1", "db.orders.get"],
      ["payment_succeeded#1", "db.orders.save"],
    ]);
    expect(plan.workers.map((w) => w.id)).toEqual([
      "checkout#1",
      "payment_succeeded#1",
      "refund#1",
      "refund#2",
    ]);
    expect(plan.expectedEffects).toEqual({ "email.send": 1, "stripe.refunds.create": 2 });
  });

  test("an unmapped model action is a precise error, not a silent skip", () => {
    const partial: ReplayMapping = {
      ...mapping,
      transitions: { ...mapping.transitions, refund: { read: ["db.orders.get"] } },
    };
    expect(() => planFromTrace(refundRaceTrace, partial)).toThrow(
      'trace step 5 (refund#1: refund.write) has no code mapping; add "refund".write to the replay mapping',
    );
  });

  test("a prefix with a worker in flight cannot be fast-forwarded", () => {
    // Pretend the duplicate webhook delivery had read the state (non-atomic) before the refunds.
    const t = structuredClone(refundRaceTrace);
    const w = t.steps[2]?.state.workers.find((x) => x.id === "payment_succeeded#2");
    if (!w) throw new Error("fixture changed");
    w.phase = "checked";
    expect(() => planFromTrace(t, mapping)).toThrow(
      "cannot fast-forward to step 3: payment_succeeded#2 read the state in the prefix and has not written yet",
    );
  });

  test("a trace with nothing to replay says so", () => {
    expect(() =>
      planFromTrace({ ...refundRaceTrace, steps: refundRaceTrace.steps.slice(0, 3) }, mapping),
    ).toThrow(
      "has nothing to replay: every action is atomic or on an unmapped transition " +
        "(mapped: checkout, expire, payment_succeeded, refund, ship); pass `replayFrom` to choose the first replayed step",
    );
  });
});

describe("planFromTrace with replayFrom (all-atomic traces)", () => {
  const mapping = mappingFromCode(ordersAppCode);
  const b1 = b1ReopenTrace;
  const b4 = b4WebhookDupTrace;

  test("the default fast-forward leaves nothing of an all-atomic trace (B4)", () => {
    expect(() => planFromTrace(b4, mapping)).toThrow("has nothing to replay");
  });

  test("B1: steps before replayFrom are seeded, even one on an unmapped transition", () => {
    // reopenOrder (step 3) has no code mapping: the test cannot call it, so it is seeded.
    expect(planFromTrace(b1, mapping, { replayFrom: 4 })).toEqual({
      property: "effect-multiplicity",
      startIndex: 4,
      seedStatus: "pending_payment",
      seedEffects: { "email.send": 1, "stripe.refunds.create": 0 },
      skipped: [
        { index: 1, worker: "checkout#1", transition: "checkout", kind: "atomic" },
        {
          index: 2,
          worker: "payment_succeeded#1",
          transition: "payment_succeeded",
          kind: "atomic",
        },
        { index: 3, worker: "reopenOrder#1", transition: "reopenOrder", kind: "atomic" },
      ],
      workers: [{ id: "payment_succeeded#2", transition: "payment_succeeded", duplicate: true }],
      schedule: [
        ["payment_succeeded#2", "db.orders.get"],
        ["payment_succeeded#2", "db.orders.save"],
        ["payment_succeeded#2", "until-done"],
      ],
      origins: [4, 4, -1],
      expectedEffects: { "email.send": 1, "stripe.refunds.create": 0 },
    });
  });

  test("B4: replayFrom 1 replays both deliveries from the initial state", () => {
    const plan = planFromTrace(b4, mapping, { replayFrom: 1 });
    expect(plan).toMatchObject({
      startIndex: 1,
      seedStatus: "draft",
      seedEffects: { "email.send": 0, "stripe.refunds.create": 0 },
      skipped: [],
      expectedEffects: { "email.send": 2, "stripe.refunds.create": 0 },
    });
    expect(plan).toEqual(planFromTrace(b4, mapping, { fastForward: false }));
  });

  test("B4: replayFrom 2 seeds the first delivery's status and receipt", () => {
    const plan = planFromTrace(b4, mapping, { replayFrom: 2 });
    expect(plan).toMatchObject({
      startIndex: 2,
      seedStatus: "paid",
      seedEffects: { "email.send": 1, "stripe.refunds.create": 0 },
      workers: [{ id: "payment_succeeded#2", duplicate: true }],
      expectedEffects: { "email.send": 1, "stripe.refunds.create": 0 },
    });
  });

  test("replayFrom keeps the in-flight check", () => {
    // B6: refund#1 has read the state at step 3 and writes at step 5.
    expect(() => planFromTrace(refundRaceTrace, mapping, { replayFrom: 4 })).toThrow(
      "cannot fast-forward to step 4: refund#1 read the state in the prefix and has not written yet",
    );
  });

  test("replayFrom must name a step after the initial state, without fastForward", () => {
    expect(() => planFromTrace(b4, mapping, { replayFrom: 0 })).toThrow(
      "planFromTrace: replayFrom 0 is not a step of the trace for effect-multiplicity (1 to 2; step 0 is the initial state)",
    );
    expect(() => planFromTrace(b4, mapping, { replayFrom: 3 })).toThrow(
      "replayFrom 3 is not a step",
    );
    expect(() => planFromTrace(b4, mapping, { replayFrom: 1, fastForward: false })).toThrow(
      "pass either `fastForward` or `replayFrom`, not both",
    );
  });

  test("the steps from replayFrom on must be mapped", () => {
    expect(() => planFromTrace(b1, mapping, { replayFrom: 3 })).toThrow(
      'trace step 3 (reopenOrder#1: reopenOrder.atomic) has no code mapping; add "reopenOrder".atomic to the replay mapping',
    );
  });
});

describe("replayVerdict", () => {
  test("the four combinations", () => {
    expect(replayVerdict({ followed: true, violated: true })).toBe("confirmed");
    expect(replayVerdict({ followed: false, violated: true })).toBe("confirmed-divergent");
    expect(replayVerdict({ followed: false, violated: false })).toBe("replay-disagrees");
    expect(replayVerdict({ followed: true, violated: false })).toBe("replay-disagrees");
  });
});
