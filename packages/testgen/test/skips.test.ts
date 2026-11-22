/** What testgen refuses to generate, and the `info` findings that say why. */
import type { BehaviorModel } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
import { describe, expect, it } from "vitest";
import cleanCode from "../../extractor/test/__golden__/orders-app.code.json" with { type: "json" };
import { generate } from "../src/index";

const OUT = ".tsv/generated/order-lifecycle";
const code = () => structuredClone(cleanCode) as unknown as BehaviorModel;

function run(spec: BehaviorModel, model: BehaviorModel = code()) {
  return generate({ spec, code: model, findings: [], outDir: OUT });
}

describe("skipped", () => {
  it("everything when the spec has no fixtures", () => {
    const { fixtures: _, ...spec } = orderModel();
    const result = run(spec);
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        id: "not-generated:Order lifecycle:testgen:fixtures",
        severity: "info",
        message: expect.stringContaining("the spec has no `fixtures`"),
      }),
    ]);
  });

  it("everything for memory persistence", () => {
    const spec = orderModel();
    spec.bindings.persistence = "memory";
    const result = run(spec);
    expect(result.files).toEqual([]);
    expect(result.skipped.map((f) => f.id)).toEqual([
      "not-generated:Order lifecycle:testgen:persistence",
    ]);
  });

  it("a transition with non-assign persistence", () => {
    const model = code();
    for (const t of model.transitions)
      if (t.name === "ship" && t.sites) t.sites.persistence = "prisma";
    const result = run(orderModel(), model);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        id: "not-generated:Order lifecycle:testgen:ship",
        transition: "ship",
        message:
          "tsv test generated no tests for `ship`: `prisma` persistence has no fakes yet (only `assign`)",
      }),
    );
    expect(result.tests.some((t) => t.transition === "ship")).toBe(false);
    expect(result.tests.some((t) => t.transition === "refund")).toBe(true);
  });

  it("a transition without an invocation shape", () => {
    const model = code();
    for (const t of model.transitions)
      if (t.name === "refund" && t.sites) delete t.sites.invocation;
    const result = run(orderModel(), model);
    expect(result.skipped.map((f) => f.message)).toContain(
      "tsv test generated no tests for `refund`: the extractor could not tell how to call src/orders/refund.ts#refundOrder (no invocation shape)",
    );
    expect(result.tests.some((t) => t.transition === "refund")).toBe(false);
  });

  it("a transition whose permitted actors have no fixture", () => {
    const spec = orderModel();
    if (spec.fixtures) delete spec.fixtures.actors.admin;
    const result = run(spec);
    expect(result.skipped.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "not-generated:Order lifecycle:testgen:refund",
        "not-generated:Order lifecycle:testgen:ship",
      ]),
    );
    // checkout is still tested, but there is no non-permitted actor with a fixture left.
    expect(result.tests.filter((t) => t.kind === "guard")).toEqual([]);
  });

  it("a transition without impl", () => {
    const spec = orderModel();
    const ship = spec.transitions.find((t) => t.name === "ship");
    if (ship) delete ship.impl;
    const result = run(spec);
    expect(result.skipped.map((f) => f.message)).toContain(
      "tsv test generated no tests for `ship`: it has no `impl`",
    );
  });

  it("everything when the entity fixture lacks the storage key", () => {
    const spec = orderModel();
    if (spec.fixtures) delete spec.fixtures.entity.id;
    const result = run(spec);
    expect(result.files).toEqual([]);
    expect(result.skipped.at(-1)?.message).toBe(
      "tsv test generated no tests: `fixtures.entity` has no string or number `id` (the key of the stored Order)",
    );
  });
});
