/**
 * Drift check: testgen mirrors parts of `@tsv/runtime` at generation time (doc 6 §2: `src/` may
 * not import it), so this runs the real runtime (a devDependency) on the same inputs and expects
 * identical results:
 *
 * - `gateMapping` (src/replay-plan.ts) ≡ `mappingFromCode(code).transitions`;
 * - the fake configs of `buildContext` (src/context.ts) ≡ `storeConfigFromCode` /
 *   `effectsConfigFromCode`, and the effect labels the generated properties use ≡
 *   `mappingFromCode(sidecar.code).effects`;
 * - the plan `planReplay` describes ≡ what `planFromTrace` returns when the generated test calls it
 *   on its sidecar, with the options written in the generated file.
 *
 * Inputs: the extractor's golden code model of the clean orders app, the B3 variant's code model
 * and counterexamples, the checker's golden spec-model trace (B6), and the all-atomic / unlinked
 * code-model traces of B4 and B1.
 */
import type { BehaviorModel, Finding, Trace } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
import {
  effectsConfigFromCode,
  mappingFromCode,
  type PlanOptions,
  planFromTrace,
  storeConfigFromCode,
} from "@tsv/runtime";
import { describe, expect, it } from "vitest";
import specTrace from "../../checker/test/__golden__/b6-refund-race.trace.json" with {
  type: "json",
};
import cleanCode from "../../extractor/test/__golden__/orders-app.code.json" with { type: "json" };
import { buildContext, type Context, effectGate } from "../src/context";
import { generate } from "../src/index";
import { gateMapping, planReplay } from "../src/replay-plan";
import b3 from "./fixtures/b3-refund-race.json" with { type: "json" };
import traces from "./fixtures/traces.json" with { type: "json" };

const OUT = ".tsv/generated/order-lifecycle";
const spec: BehaviorModel = { ...orderModel(), file: "src/orders/order.behavior.yaml" };
const clean = cleanCode as unknown as BehaviorModel;
const b3Code = b3.code as unknown as BehaviorModel;

/** The clean code model with repeated calls and transitions the mapping must ignore. */
function edgeCases(): BehaviorModel {
  const code = structuredClone(clean);
  const refund = code.transitions.find((t) => t.name === "refund")?.sites;
  const ship = code.transitions.find((t) => t.name === "ship")?.sites;
  if (!refund?.read || !refund.commit || !ship?.read) throw new Error("golden changed shape");
  // The relevant read is the third `db.orders.get`; the commit reuses the read's gate.
  refund.read.occurrence = 2;
  ship.commit = { ...ship.read, occurrence: 1 };
  const [first] = code.transitions;
  if (!first) throw new Error("golden changed shape");
  code.transitions.push(
    // A write not named after its spec transition, and a transition without sites.
    { ...structuredClone(first), name: `${first.name}->cancelled` },
    { ...structuredClone(first), name: "audit", sites: undefined },
  );
  return code;
}

const models: [string, BehaviorModel][] = [
  ["clean orders app", clean],
  ["B3 variant", b3Code],
  ["repeated calls, unlinked writes", edgeCases()],
];

function context(code: BehaviorModel): Context {
  const { ctx } = buildContext({ spec, code, outDir: OUT });
  if (ctx === undefined) throw new Error("no context");
  return ctx;
}

describe("gate mapping ≡ mappingFromCode", () => {
  it.each(models)("%s", (_, code) => {
    expect(Object.fromEntries(gateMapping(code))).toEqual(mappingFromCode(code).transitions);
  });

  it("covers repeated calls", () => {
    expect(mappingFromCode(edgeCases()).transitions).toMatchObject({
      refund: { read: ["db.orders.get", "db.orders.get", "db.orders.get"] },
      ship: { read: ["db.orders.get"], write: ["db.orders.get"] },
    });
  });
});

describe("fake configs ≡ storeConfigFromCode / effectsConfigFromCode", () => {
  it.each(models)("%s", (_, code) => {
    const ctx = context(code);
    expect(ctx.stores.map((s) => s.client)).toEqual(["db"]);
    for (const store of ctx.stores) expect(store).toEqual(storeConfigFromCode(code, store.client));
    expect(ctx.effects.map((e) => e.client)).toEqual(["email", "stripe"]);
    // Testgen also fakes the calls the spec binds effects to; here they are all in the code too.
    for (const fake of ctx.effects) {
      expect(fake).toEqual(effectsConfigFromCode(code, fake.client));
    }
  });

  it("both refuse a client with two transaction methods", () => {
    const code = structuredClone(clean);
    const sites = code.transitions.find((t) => t.name === "ship")?.sites;
    const refund = code.transitions.find((t) => t.name === "refund")?.sites?.atomic;
    if (!sites || refund?.kind !== "transaction") throw new Error("golden changed shape");
    sites.atomic = { ...refund, gate: "db.batch" };
    expect(() => storeConfigFromCode(code, "db")).toThrow(
      'client "db" opens transactions through several methods (batch, transaction)',
    );
    const { ctx, skipped } = buildContext({ spec, code, outDir: OUT });
    expect(ctx).toBeUndefined();
    expect(skipped.at(-1)?.message).toContain(
      "client `db` opens transactions through several methods (batch, transaction)",
    );
  });

  it.each(models)("%s: effect labels ≡ mappingFromCode(sidecar code).effects", (_, code) => {
    const ctx = context(code);
    const sidecar = sidecarOf(generate({ spec, code, findings: [finding(b4())], outDir: OUT }));
    const runtime = mappingFromCode(sidecar.code).effects;
    for (const e of spec.transitions.flatMap((t) => t.effects.map((x) => x.name))) {
      expect(runtime[e], e).toBe(effectGate(ctx, e));
    }
  });
});

function b4(): Trace {
  return traces["b4-webhook-dup"] as unknown as Trace;
}

function finding(trace: Trace): Finding {
  return {
    id: `implementation-property:Order lifecycle:${trace.property}:cross-check`,
    category: "implementation-property",
    severity: "error",
    message: "Cross-check.",
    behavior: "Order lifecycle",
    property: trace.property,
    trace,
  };
}

interface Sidecar {
  trace: Trace;
  code: Parameters<typeof mappingFromCode>[0];
}

function sidecarOf(result: ReturnType<typeof generate>, n = 1): Sidecar {
  const file = result.files.find((f) => f.path === `replay-${n}.json`);
  if (!file) throw new Error(`no replay-${n}.json`);
  return JSON.parse(file.content) as Sidecar;
}

/** The options the generated test passes to `planFromTrace`, parsed from its source. */
function optionsOf(result: ReturnType<typeof generate>, n = 1): PlanOptions {
  const file = result.files.find((f) => f.path === `replay-${n}.test.ts`);
  const m = file?.content.match(
    /^const plan = planFromTrace\(sidecar\.trace, mappingFromCode\(sidecar\.code\)(?:, \{ replayFrom: (\d+) \})?\);$/m,
  );
  if (!m) throw new Error(`no planFromTrace call in replay-${n}.test.ts`);
  return m[1] === undefined ? {} : { replayFrom: Number(m[1]) };
}

const replays: { name: string; code: BehaviorModel; trace: Trace; options: PlanOptions }[] = [
  {
    name: "B6 spec-model refund race",
    code: clean,
    trace: specTrace as unknown as Trace,
    options: {},
  },
  ...(b3.findings as unknown as Finding[]).map((f) => ({
    name: `B3 ${f.property}`,
    code: b3Code,
    trace: f.trace as Trace,
    options: {},
  })),
  { name: "B4 all-atomic redelivery", code: clean, trace: b4(), options: { replayFrom: 1 } },
  {
    name: "B1 unlinked reopenOrder",
    code: clean,
    trace: traces["b1-reopen"] as unknown as Trace,
    options: { replayFrom: 4 },
  },
];

describe("planReplay ≡ planFromTrace on the generated sidecar", () => {
  it.each(replays)("$name", ({ code, trace, options }) => {
    const result = generate({ spec, code, findings: [finding(trace)], outDir: OUT });
    const sidecar = sidecarOf(result);
    expect(sidecar.trace).toEqual(trace);
    expect(optionsOf(result)).toEqual(options);

    const ctx = context(code);
    const planned = planReplay(trace, gateMapping(code), (t) => ctx.linked.has(t));
    if (!planned.ok) throw new Error(planned.reason);
    const view = planned.plan;
    const plan = planFromTrace(sidecar.trace, mappingFromCode(sidecar.code), optionsOf(result));

    expect(plan.startIndex).toBe(view.replayed[0]?.index);
    expect(plan.skipped.map((s) => s.index)).toEqual(
      view.skipped.filter((s) => s.action).map((s) => s.index),
    );
    expect(plan.seedStatus).toBe(view.seed.status);
    expect(plan.workers).toEqual(view.workers);
    expect(plan.schedule).toEqual([
      ...view.schedule.map((g) => [g.worker, g.gate]),
      ...view.workers.map((w) => [w.id, "until-done"]),
    ]);
    expect(plan.origins).toEqual([
      ...view.schedule.map((g) => g.step),
      ...view.workers.map(() => -1),
    ]);
    // The generated property reads `plan.seedEffects[effectGate(effect)]`.
    for (const [effect, n] of Object.entries(view.seed.effects)) {
      expect(plan.seedEffects[effectGate(ctx, effect)], effect).toBe(n);
    }
  });

  it("the default fast-forward would leave nothing of B4", () => {
    expect(() => planFromTrace(b4(), mappingFromCode(clean))).toThrow("has nothing to replay");
  });
});
