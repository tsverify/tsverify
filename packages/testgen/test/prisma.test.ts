/**
 * `prisma` persistence: generated tests use `instrument.prisma` for the Prisma client, built from
 * the extractor's golden code model of examples/orders-prisma. The mirrors of the runtime
 * (`buildContext`'s fake config, `gateMapping`, `planReplay`) are checked against the real
 * `@tsv/runtime` on the same inputs, as in `runtime-cross-check.test.ts`. The generated files run
 * against the real app in examples/orders-prisma/test/test-command.e2e.test.ts.
 */
import type { BehaviorModel, Finding, Trace } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
import { mappingFromCode, planFromTrace, prismaConfigFromCode } from "@tsv/runtime";
import { describe, expect, it } from "vitest";
import specTrace from "../../checker/test/__golden__/b6-refund-race.trace.json" with {
  type: "json",
};
import prismaCode from "../../extractor/test/__golden__/orders-prisma.code.json" with {
  type: "json",
};
import { buildContext } from "../src/context";
import { generate } from "../src/index";
import { gateMapping, planReplay } from "../src/replay-plan";
import traces from "./fixtures/traces.json" with { type: "json" };

const OUT = ".tsv/generated/order-lifecycle";
const code = prismaCode as unknown as BehaviorModel;

/** examples/orders-prisma's spec: the canonical one with Prisma bindings. */
function spec(): BehaviorModel {
  const base = orderModel();
  const { db: _, ...others } = base.bindings.clients;
  return {
    ...base,
    file: "src/orders/order.behavior.yaml",
    bindings: {
      ...base.bindings,
      persistence: "prisma",
      clients: { ...others, prisma: { module: "src/db.ts", export: "prisma" } },
    },
  };
}

function finding(trace: Trace): Finding {
  return {
    id: `implementation-property:Order lifecycle:${trace.property}:prisma`,
    category: "implementation-property",
    severity: "error",
    message: "Prisma.",
    behavior: "Order lifecycle",
    property: trace.property,
    trace,
  };
}

describe("clean orders-prisma app", () => {
  const result = generate({ spec: spec(), code, findings: [], outDir: OUT });

  it("generates the same tests as for the assign app", () => {
    expect(result.files.map((f) => f.path)).toEqual([
      "paths.test.ts",
      "forbidden.test.ts",
      "guards.test.ts",
    ]);
    expect(result.tests.filter((t) => t.kind === "path")).toHaveLength(5);
    expect(result.tests.filter((t) => t.kind === "forbidden")).toHaveLength(25);
    expect(result.tests.filter((t) => t.kind === "guard")).toHaveLength(3);
    expect(result.skipped.map((f) => f.id)).toEqual([
      "not-generated:Order lifecycle:testgen:guards:expire",
      "not-generated:Order lifecycle:testgen:guards:payment_succeeded",
    ]);
  });

  it("fakes the Prisma client with instrument.prisma", async () => {
    const paths = result.files.find((f) => f.path === "paths.test.ts")?.content;
    expect(paths).toContain("const prisma = instrument.prisma(s, {");
    expect(paths).toContain('vi.mock("../../../src/db.ts", () => ({ prisma: prisma.client }));');
    await expect(paths).toMatchFileSnapshot("__golden__/prisma-clean/paths.test.ts.txt");
  });
});

describe("prisma mirrors ≡ @tsv/runtime", () => {
  const { ctx } = buildContext({ spec: spec(), code, outDir: OUT });

  it("fake config ≡ prismaConfigFromCode", () => {
    expect(ctx?.stores).toEqual([]);
    expect(ctx?.prismas).toEqual([prismaConfigFromCode(code, "prisma")]);
    expect(ctx?.prismas[0]).toEqual({
      client: "prisma",
      models: { order: { key: "id" } },
      read: ["order.findUniqueOrThrow"],
      write: ["order.update", "order.updateMany"],
    });
    expect(ctx?.effects.map((e) => e.client)).toEqual(["email", "stripe"]);
  });

  it("gate mapping ≡ mappingFromCode: a conditional update's atomic step is read + update", () => {
    expect(Object.fromEntries(gateMapping(code))).toEqual(mappingFromCode(code).transitions);
    expect(mappingFromCode(code).transitions.refund).toEqual({
      read: ["prisma.order.findUniqueOrThrow"],
      write: ["prisma.order.updateMany"],
      atomic: ["prisma.order.findUniqueOrThrow", "prisma.order.updateMany"],
    });
    expect(mappingFromCode(code).transitions.payment_succeeded).toEqual({
      read: [],
      write: ["prisma.order.updateMany"],
      atomic: ["prisma.order.updateMany"],
    });
  });

  it.each([
    ["B6 spec-model refund race", specTrace as unknown as Trace],
    ["B4 all-atomic redelivery", traces["b4-webhook-dup"] as unknown as Trace],
    ["B1 unlinked reopenOrder", traces["b1-reopen"] as unknown as Trace],
  ])("%s: planReplay ≡ planFromTrace", (_, trace) => {
    const result = generate({ spec: spec(), code, findings: [finding(trace)], outDir: OUT });
    const test = result.files.find((f) => f.path === "replay-1.test.ts")?.content ?? "";
    const m = test.match(/mappingFromCode\(sidecar\.code\)(?:, \{ replayFrom: (\d+) \})?\);$/m);
    const options = m?.[1] === undefined ? {} : { replayFrom: Number(m[1]) };
    const planned = planReplay(trace, gateMapping(code), (t) => ctx?.linked.has(t) ?? false);
    if (!planned.ok) throw new Error(planned.reason);
    const sidecar = JSON.parse(result.files.find((f) => f.path === "replay-1.json")?.content ?? "");
    const plan = planFromTrace(sidecar.trace, mappingFromCode(sidecar.code), options);
    expect(plan.schedule).toEqual([
      ...planned.plan.schedule.map((g) => [g.worker, g.gate]),
      ...planned.plan.workers.map((w) => [w.id, "until-done"]),
    ]);
    expect(plan.seedStatus).toBe(planned.plan.seed.status);
  });
});
