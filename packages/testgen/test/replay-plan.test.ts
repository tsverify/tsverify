/**
 * How a counterexample becomes a replay: the runtime's default fast-forward when it leaves
 * something drivable to replay, otherwise a cut after the last step the test cannot drive.
 */
import type { BehaviorModel, Finding, Trace } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
import { describe, expect, it } from "vitest";
import specTrace from "../../checker/test/__golden__/b6-refund-race.trace.json" with {
  type: "json",
};
import cleanCode from "../../extractor/test/__golden__/orders-app.code.json" with { type: "json" };
import { generate } from "../src/index";
import { gateMapping, planReplay } from "../src/replay-plan";
import traces from "./fixtures/traces.json" with { type: "json" };

const code = cleanCode as unknown as BehaviorModel;
const gates = gateMapping(code);
const linked = new Set(["checkout", "expire", "payment_succeeded", "refund", "ship"]);
const drivable = (t: string) => linked.has(t);

function multiplicity(trace: Trace, effect: string): Finding {
  return {
    id: `implementation-property:Order lifecycle:effect-multiplicity:${effect}`,
    category: "implementation-property",
    severity: "error",
    message: `Exactly-once effect \`${effect}\` fires 2 times for one Order.`,
    behavior: "Order lifecycle",
    property: "effect-multiplicity",
    trace,
  };
}

describe("gateMapping (mirrors the runtime's mappingFromCode)", () => {
  it("maps read, write and atomic actions to the sync gates", () => {
    expect(gates.get("refund")).toEqual({
      read: ["db.orders.get"],
      write: ["db.orders.save"],
      atomic: ["db.orders.get", "db.orders.save"],
    });
    expect([...gates.keys()]).toEqual([
      "checkout",
      "expire",
      "payment_succeeded",
      "refund",
      "ship",
    ]);
  });
});

describe("planReplay", () => {
  it("fast-forwards the leading atomic steps like the runtime (B6 race)", () => {
    const planned = planReplay(specTrace as unknown as Trace, gates, drivable);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.fastForward).toBe(true);
    expect(planned.plan.trace).toBe(specTrace);
    expect(planned.plan.skipped.map((s) => s.action?.worker)).toEqual([
      "checkout#1",
      "payment_succeeded#1",
    ]);
    expect(planned.plan.seed.status).toBe("paid");
    expect(planned.plan.schedule.map((s) => `${s.worker} ${s.gate}`)).toEqual([
      "refund#1 db.orders.get",
      "refund#2 db.orders.get",
      "refund#1 db.orders.save",
      "refund#2 db.orders.save",
    ]);
  });

  it("replays everything when every step is atomic (B4 duplicate webhook)", () => {
    const trace = traces["b4-webhook-dup"] as unknown as Trace;
    const planned = planReplay(trace, gates, drivable);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.fastForward).toBe(false);
    expect(planned.plan.skipped).toEqual([]);
    expect(planned.plan.seed.status).toBe("draft");
    expect(planned.plan.workers).toEqual([
      { id: "payment_succeeded#1", transition: "payment_succeeded" },
      { id: "payment_succeeded#2", transition: "payment_succeeded", duplicate: true },
    ]);
  });

  it("cuts after a step on a transition the test cannot call (B1 reopenOrder)", () => {
    const trace = traces["b1-reopen"] as unknown as Trace;
    const planned = planReplay(trace, gates, drivable);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.fastForward).toBe(false);
    expect(planned.plan.skipped.map((s) => s.action?.worker)).toEqual([
      "checkout#1",
      "payment_succeeded#1",
      "reopenOrder#1",
    ]);
    expect(planned.plan.seed).toMatchObject({
      status: "pending_payment",
      effects: { "email.receipt": 1 },
    });
    // The sidecar trace starts at the cut: its first step is the seeded state, without action.
    expect(planned.plan.trace.steps.map((s) => [s.index, s.action?.worker])).toEqual([
      [3, undefined],
      [4, "payment_succeeded#2"],
    ]);
  });

  it("refuses when nothing drivable is left after the cut", () => {
    const trace = traces["b1-reopen"] as unknown as Trace;
    const planned = planReplay(trace, gates, (t) => t !== "payment_succeeded" && drivable(t));
    expect(planned).toEqual({
      ok: false,
      reason:
        "its last step (payment_succeeded#2: payment_succeeded) is on a transition the generated test cannot call, so nothing is left to replay",
    });
  });
});

describe("generated replay options", () => {
  const spec = { ...orderModel(), file: "src/orders/order.behavior.yaml" };

  it("passes { fastForward: false } with the cut trace", () => {
    const trace = traces["b1-reopen"] as unknown as Trace;
    const result = generate({
      spec,
      code,
      findings: [multiplicity(trace, "email.receipt")],
      outDir: ".tsv/generated/order-lifecycle",
    });
    const test = result.files.find((f) => f.path === "replay-1.test.ts")?.content ?? "";
    expect(test).toContain(
      "const plan = planFromTrace(sidecar.trace, mappingFromCode(sidecar.code), { fastForward: false });",
    );
    expect(test).toContain(
      '// steps 1-3 (checkout#1 atomic, payment_succeeded#1 atomic, reopenOrder#1 atomic) fast-forwarded: seed status "pending_payment"',
    );
    expect(test).toContain('const violated = !((effects["email.send"] ?? 0) <= 1);');
    const sidecar = JSON.parse(result.files.find((f) => f.path === "replay-1.json")?.content ?? "");
    expect(sidecar.trace.steps).toHaveLength(2);
  });

  it("explains a counterexample it cannot replay", () => {
    const trace = traces["b1-reopen"] as unknown as Trace;
    const withoutWebhook: BehaviorModel = {
      ...code,
      transitions: code.transitions.filter((t) => t.name !== "payment_succeeded"),
    };
    const result = generate({
      spec,
      code: withoutWebhook,
      findings: [multiplicity(trace, "email.receipt")],
      outDir: ".tsv/generated/order-lifecycle",
    });
    expect(result.files.some((f) => f.path.startsWith("replay-"))).toBe(false);
    expect(result.skipped.map((f) => f.id)).toContain(
      "unanalyzable:Order lifecycle:testgen:replay:implementation-property:Order lifecycle:effect-multiplicity:email.receipt",
    );
  });

  it("emits an inconclusive replay for a liveness rule", () => {
    const trace = {
      ...(specTrace as unknown as Trace),
      property: "rule:Unpaid orders don't linger",
    };
    const result = generate({
      spec,
      code,
      findings: [
        {
          id: "spec-property:Order lifecycle:rule:Unpaid orders don't linger",
          category: "spec-property",
          severity: "error",
          message: "Rule violated.",
          trace: { ...trace, kind: "liveness" },
        },
      ],
      outDir: ".tsv/generated/order-lifecycle",
    });
    const test = result.files.find((f) => f.path === "replay-1.test.ts")?.content ?? "";
    expect(test).toContain("inconclusive: true");
    expect(test).not.toContain("expect(result.violated");
    expect(result.tests.at(-1)).toMatchObject({ kind: "replay", evaluable: false });
  });
});
