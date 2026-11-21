// Drive the replay from the checker's real counterexample format (packages/ir Trace).
import { readFileSync } from "node:fs";
import type { Trace } from "@tsv/ir";
import { describe, expect, test, vi } from "vitest";
import {
  instrument,
  planFromTrace,
  type ReplayMapping,
  replayVerdict,
  scheduler,
} from "../runtime/index";
import { paidOrder, RUNS } from "./fixtures";

const s = scheduler();
const db = instrument.store(s, { name: "db", collections: { orders: { key: "id" } } });
const stripe = instrument.effects(s, { name: "stripe", calls: ["refunds.create"] });

vi.mock("../app/db", () => ({ db: db.client }));
vi.mock("../app/stripe", () => ({ stripe: stripe.client }));

const buggy = await import("../app/refund-buggy");
const fixed = await import("../app/refund-fixed");

const trace = JSON.parse(
  readFileSync(
    new URL("../../../packages/checker/test/__golden__/b6-refund-race.trace.json", import.meta.url),
    "utf8",
  ),
) as Trace;

/**
 * Model action → code gate. In tsv this table is derived from the extractor's `Transition.sites`
 * (read/write call sites resolved to client call paths) and the spec's `bindings.effects`.
 */
const MAPPING: ReplayMapping = {
  transitions: { refund: { read: ["db.orders.get"], write: ["db.orders.save"] } },
  effects: { "stripe.refund": "stripe.refunds.create" },
};

/** How to invoke each transition's impl for the entity under test (from `Transition.impl`). */
function invokers(impl: typeof buggy): Record<string, () => Promise<unknown>> {
  return { refund: () => impl.refundOrder("o1") };
}

async function replayTrace(impl: typeof buggy) {
  const plan = planFromTrace(trace, MAPPING);
  s.reset();
  db.seed("orders", [{ ...paidOrder(), status: plan.seedStatus }]);
  const invoke = invokers(impl);
  for (const w of plan.workers) {
    const fn = invoke[w.transition];
    if (!fn) throw new Error(`no invoker for ${w.transition}`);
    s.spawn(w.id, fn);
  }
  const outcome = await s.tryPlay(plan.schedule);
  await s.drain();
  const label = "stripe.refunds.create";
  const actual = s.effects(label).length;
  const expected = plan.expectedEffects[label] ?? 0;
  const violated = actual > 1; // the rule: "Refund issued at most once per order"
  return {
    verdict: replayVerdict({ followed: outcome.followed, violated }),
    divergence: outcome.followed ? null : outcome.divergence.kind,
    refunds: { actual, expected },
    gates: s.gateLog().map((e) => `${e.worker}:${e.gate}`),
  };
}

describe("schedule from the checker's b6-refund-race trace", () => {
  test("plan: prefix fast-forwarded by seeding, refund actions mapped to gates", () => {
    const plan = planFromTrace(trace, MAPPING);
    expect(plan).toEqual({
      property: "rule:Refund issued at most once per order",
      startIndex: 3, // steps 1-2 (checkout, payment_succeeded) are replaced by seeding `paid`
      seedStatus: "paid",
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
      expectedEffects: { "email.receipt": 0, "stripe.refunds.create": 2 },
    });
  });

  test(`refund-buggy: confirmed, reproduces the model's effect count, ${RUNS}/${RUNS}`, async () => {
    const results = new Set<string>();
    for (let i = 0; i < RUNS; i++) results.add(JSON.stringify(await replayTrace(buggy)));
    expect([...results].map((r) => JSON.parse(r))).toEqual([
      {
        verdict: "confirmed",
        divergence: null,
        refunds: { actual: 2, expected: 2 },
        gates: [
          "refund#1:db.orders.get",
          "refund#2:db.orders.get",
          "refund#1:stripe.refunds.create",
          "refund#1:db.orders.save",
          "refund#2:stripe.refunds.create",
          "refund#2:db.orders.save",
        ],
      },
    ]);
  });

  test(`refund-fixed: replay-disagrees (blocked by the transaction), ${RUNS}/${RUNS}`, async () => {
    const results = new Set<string>();
    for (let i = 0; i < RUNS; i++) results.add(JSON.stringify(await replayTrace(fixed)));
    expect([...results].map((r) => JSON.parse(r))).toEqual([
      {
        verdict: "replay-disagrees",
        divergence: "blocked",
        refunds: { actual: 1, expected: 2 },
        gates: [
          "refund#1:db.transaction",
          "refund#1:db.orders.get",
          "refund#2:db.transaction",
          "refund#1:db.orders.save",
          "refund#1:stripe.refunds.create",
          "refund#2:db.orders.get",
        ],
      },
    ]);
  });

  test("an unmapped model action is a precise error, not a silent skip", () => {
    expect(() =>
      planFromTrace(trace, { ...MAPPING, transitions: { refund: { read: ["db.orders.get"] } } }),
    ).toThrow(
      'trace step 5 (refund#1: refund.write) has no code mapping; add "refund".write to the replay mapping',
    );
  });

  test("a prefix with an unmapped worker in flight cannot be fast-forwarded", () => {
    // Pretend the duplicate webhook delivery had read the state (non-atomic) before the refunds.
    const t = structuredClone(trace);
    const w = t.steps[2]?.state.workers.find((x) => x.id === "payment_succeeded#2");
    if (!w) throw new Error("fixture changed");
    w.phase = "checked";
    expect(() => planFromTrace(t, MAPPING)).toThrow(
      "cannot fast-forward to step 3: payment_succeeded#2 read the state in the prefix and has not written yet",
    );
  });
});
