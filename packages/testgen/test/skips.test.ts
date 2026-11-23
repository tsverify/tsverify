/** What testgen refuses to generate, and the `info` findings that say why. */
import type { BehaviorModel } from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";
import { describe, expect, it } from "vitest";
import cleanCode from "../../extractor/test/__golden__/orders-app.code.json" with { type: "json" };
import { generate } from "../src/index";

const OUT = ".tsverify/generated/order-lifecycle";
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

  it("everything when a link in the spec is broken, naming it", () => {
    const broken = {
      id: "broken-link:Order lifecycle:client:mailer",
      category: "broken-link" as const,
      severity: "error" as const,
      message:
        'client "mailer" (src/mail.ts#mailer) does not resolve: src/mail.ts does not export "mailer"',
      behavior: "Order lifecycle",
    };
    const other = { ...broken, id: "broken-link:Other:client:x", behavior: "Other" };
    const result = generate({ spec: orderModel(), code: code(), findings: [broken], outDir: OUT });
    expect(result.files).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.skipped).toEqual([
      {
        id: "not-generated:Order lifecycle:testgen:bindings",
        category: "not-generated",
        severity: "info",
        message: `tsverify test generated no tests: a link in the spec is broken, and the tests would import, call or replace what it names: ${broken.message}`,
        behavior: "Order lifecycle",
        hint: "Fix the broken-link findings (`tsverify check` reports them), then run `tsverify test` again.",
      },
    ]);
    // Another spec's broken link doesn't stop this one.
    const fine = generate({ spec: orderModel(), code: code(), findings: [other], outDir: OUT });
    expect(fine.tests.length).toBeGreaterThan(0);
  });

  it("a transition whose write tsverify couldn't read: unconfirmed, as check says, not missing", () => {
    const model = code();
    model.transitions = model.transitions.filter((t) => t.name !== "ship");
    model.unreadWrites = {
      ship: [
        {
          at: { file: "src/admin/orders.ts", line: 12, column: 3 },
          function: "shipOrder",
          reason: "the value `next` is not a single literal",
          finding: "unanalyzable:Order lifecycle:write:shipOrder",
        },
      ],
    };
    const result = run(orderModel(), model);
    const ship = result.skipped.find((f) => f.id === "not-generated:Order lifecycle:testgen:ship");
    expect(ship?.message).toBe(
      "tsverify test generated no tests for `ship`: tsverify couldn't confirm that src/admin/orders.ts#shipOrder writes `shipped`: it changes status at orders.ts:12 in a form tsverify can't read (the value `next` is not a single literal), so it can't tell which test would reach that write",
    );
    expect(ship?.message).not.toContain("found no write");
    expect(ship?.hint).toContain("status = 'shipped' as a literal");
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

  it("a transition with a persistence that has no fakes", () => {
    const model = code();
    for (const t of model.transitions)
      if (t.name === "ship" && t.sites) t.sites.persistence = "drizzle";
    const result = run(orderModel(), model);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        id: "not-generated:Order lifecycle:testgen:ship",
        transition: "ship",
        message:
          "tsverify test generated no tests for `ship`: `drizzle` persistence has no fakes yet (only `assign` and `prisma`)",
      }),
    );
    expect(result.tests.some((t) => t.transition === "ship")).toBe(false);
    expect(result.tests.some((t) => t.transition === "refund")).toBe(true);
  });

  it("a transition whose impl is an instance method, instead of calling it as a static one", () => {
    const model = code();
    model.instanceImpls = ["ship"];
    const result = run(orderModel(), model);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        id: "not-generated:Order lifecycle:testgen:ship",
        transition: "ship",
        message:
          "tsverify test generated no tests for `ship`: its impl src/admin/orders.ts#shipOrder is an instance method, and a generated test can't build an object of its class to call it on yet",
        hint: "Test it with your own tests, or point `impl` at a function or static method that does the work.",
      }),
    );
    expect(result.tests.some((t) => t.transition === "ship")).toBe(false);
    expect(result.files.some((f) => f.content.includes("shipOrder("))).toBe(false);
    expect(result.tests.some((t) => t.transition === "refund")).toBe(true);
  });

  it("a transition whose impl a test can't import or call (not exported, private)", () => {
    const model = code();
    model.hiddenImpls = {
      ship: "its impl src/admin/orders.ts#shipOrder is not exported (shipOrder is not an export of src/admin/orders.ts), so a generated test can't import it",
    };
    const result = run(orderModel(), model);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        id: "not-generated:Order lifecycle:testgen:ship",
        severity: "info",
        message:
          "tsverify test generated no tests for `ship`: its impl src/admin/orders.ts#shipOrder is not exported (shipOrder is not an export of src/admin/orders.ts), so a generated test can't import it",
        hint: "Export it, or point `impl` at an exported function that calls it.",
      }),
    );
    expect(result.files.some((f) => f.content.includes("shipOrder("))).toBe(false);
    expect(result.tests.some((t) => t.transition === "refund")).toBe(true);
  });

  it("everything when a bound export can't be replaced by a fake", () => {
    const model = code();
    model.unfakeable = [
      { binding: "clients.stripe", reason: "client stripe is the class Stripe, …" },
      { binding: "storage.Store.get", reason: "Store.get is a method of Store, a type, …" },
    ];
    const result = run(orderModel(), model);
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        id: "not-generated:Order lifecycle:testgen:fakes",
        message:
          "tsverify test generated no tests: the generated tests replace every export the spec binds with a fake, and can't replace these: client stripe is the class Stripe, …; Store.get is a method of Store, a type, …",
      }),
    ]);
  });

  it("a transition whose key argument tsverify can't trace, without fixtures.args", () => {
    const model = code();
    for (const t of model.transitions)
      if (t.name === "refund" && t.sites) delete t.sites.invocation;
    const result = run(orderModel(), model);
    const f = result.skipped.find((x) => x.transition === "refund");
    expect(f?.message).toBe(
      "tsverify test generated no tests for `refund`: tsverify can't tell which arguments of src/orders/refund.ts#refundOrder carry the Order's key and the actor (it couldn't trace the key the code reads the Order with back to a parameter)",
    );
    expect(f?.hint).toContain("`fixtures.args.refund`, with `$id` where the key goes");
    expect(result.tests.some((t) => t.transition === "refund")).toBe(false);
  });

  it("with fixtures.args, no traced arguments are needed", () => {
    const model = code();
    for (const t of model.transitions)
      if (t.name === "refund" && t.sites) delete t.sites.invocation;
    const spec = orderModel();
    if (spec.fixtures)
      spec.fixtures.args.refund = [{ ctx: { actor: "$actor" }, input: { id: "$id" } }];
    const result = run(spec, model);
    expect(result.skipped.some((f) => f.transition === "refund")).toBe(false);
    expect(result.tests.some((t) => t.transition === "refund")).toBe(true);
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
      "tsverify test generated no tests for `ship`: it has no `impl`",
    );
  });

  it("everything when the entity fixture lacks the storage key", () => {
    const spec = orderModel();
    if (spec.fixtures) delete spec.fixtures.entity.id;
    const result = run(spec);
    expect(result.files).toEqual([]);
    expect(result.skipped.at(-1)?.message).toBe(
      "tsverify test generated no tests: `fixtures.entity` has no string or number `id` (the key of the stored Order)",
    );
  });
});
