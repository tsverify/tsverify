import type { BehaviorModel, Transition } from "@tsv/ir";
import { compareStrings } from "@tsv/ir";
import { orderModel } from "@tsv/ir/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROOT, materialize } from "../../../examples/orders-app/test/materialize";
import { type ExtractResult, extractAll } from "../src/index";
import { guardKeys, transitionOf } from "./helpers";

function extractApp(root: string): ExtractResult {
  const { results } = extractAll([orderModel()], { projectRoot: root });
  return results[0] as ExtractResult;
}

/** Guards the spec requires for `t`: its own plus those implied by its actors. */
function requiredGuards(spec: BehaviorModel, t: Transition): string[] {
  const keys = new Set(t.requires.map((g) => g.raw));
  for (const by of t.by) for (const g of spec.actors[by]?.requires ?? []) keys.add(g.raw);
  return [...keys].sort(compareStrings);
}

describe("orders-app (clean)", () => {
  const result = extractApp(APP_ROOT);
  const spec = orderModel();

  it("reports no findings", () => {
    expect(result.findings).toEqual([]);
  });

  it("extracts exactly one code transition per spec transition", () => {
    expect(result.model?.transitions.map((t) => t.name)).toEqual(
      spec.transitions.map((t) => t.name),
    );
  });

  it.each(orderModel().transitions.map((t) => [t.name, t] as const))(
    "%s matches the spec",
    (name, t) => {
      const code = transitionOf(result, name);
      expect(code.sites?.specTransition).toBe(name);
      expect(code.to).toBe(t.to);
      expect(code.from).toEqual(t.from);
      expect(code.sites?.fromState.unconstrained).toBe(false);
      expect(code.atomic).toBe(t.atomic);
      expect(guardKeys(code)).toEqual(requiredGuards(spec, t));
      expect(code.effects).toEqual(t.effects);
      expect(code.by).toEqual(t.by);
      expect(code.idempotent).toBe(t.idempotent);
      expect(code.impl).toEqual(t.impl);
      expect(code.sites?.invocation?.impl).toEqual(t.impl);
      expect(code.sites?.invocation?.entityId).toBeDefined();
      expect(code.sites?.storage).toEqual({ client: "db", collection: "orders", key: "id" });
      expect(code.sites?.read?.gate).toBe("db.orders.get");
      expect(code.sites?.commit?.gate).toBe("db.orders.save");
      expect(code.sites?.atomic?.gate).toBe("db.transaction");
    },
  );

  it("traces invocation arguments to the impl parameters", () => {
    const inv = (n: string) => transitionOf(result, n).sites?.invocation;
    expect(inv("checkout")).toMatchObject({
      entityId: { param: 1, path: [] },
      actor: { param: 0, path: ["actor"] },
    });
    expect(inv("payment_succeeded")).toEqual({
      impl: { file: "src/payments/webhook.ts", symbol: "onPaymentSucceeded" },
      entityId: { param: 0, path: ["orderId"] },
    });
    expect(inv("expire")?.actor).toBeUndefined();
  });

  it("matches the golden code model", async () => {
    await expect(`${JSON.stringify(result.model, null, 2)}\n`).toMatchFileSnapshot(
      "__golden__/orders-app.code.json",
    );
  });

  it("builds one program and probes every candidate write", () => {
    const { stats } = extractAll([orderModel()], { projectRoot: APP_ROOT });
    expect(stats).toMatchObject({ files: 13, writes: 5, probes: 5 });
  });
});

describe("orders-app variants", () => {
  const extracted = new Map<string, ExtractResult>();
  const clean = extractApp(APP_ROOT);

  beforeAll(async () => {
    for (const id of [
      "b1-reopen",
      "b2-guard-bypass",
      "b3-refund-race",
      "b4-webhook-dup",
      "b5-undeclared-effect",
      "b6-spec-race",
    ]) {
      const app = await materialize(id);
      try {
        extracted.set(id, extractApp(app.root));
      } finally {
        await app.dispose();
      }
    }
  }, 60_000);

  afterAll(() => extracted.clear());

  const variant = (id: string) => extracted.get(id) as ExtractResult;

  it("B1: reopenOrder is an unlinked paid → pending_payment transition", () => {
    const t = transitionOf(variant("b1-reopen"), "reopenOrder");
    expect(t.sites?.specTransition).toBeUndefined();
    expect(t).toMatchObject({ from: ["paid"], to: "pending_payment", by: [], atomic: true });
    expect(t.sites?.function).toMatchObject({ file: "src/admin/orders.ts", name: "reopenOrder" });
    expect(variant("b1-reopen").findings).toEqual([]);
  });

  it("B2: refund does not require role(admin); its guard call does not dominate", () => {
    const t = transitionOf(variant("b2-guard-bypass"), "refund");
    expect(guardKeys(t)).toEqual([]);
    expect(t.sites?.guards).toEqual([
      expect.objectContaining({ guard: "role(admin)", dominates: false }),
    ]);
    expect(t.sites?.function.name).toBe("issueRefund");
    expect(t.atomic).toBe(true);
    expect(t.effects.map((e) => e.name)).toEqual(["stripe.refund"]);
  });

  it("B3: refund is not atomic: read and commit are outside any scope", () => {
    const t = transitionOf(variant("b3-refund-race"), "refund");
    expect(t.atomic).toBe(false);
    expect(t.sites?.atomic).toBeUndefined();
    expect(t.sites?.read).toMatchObject({ gate: "db.orders.get", at: { line: 10 } });
    expect(t.sites?.commit).toMatchObject({ gate: "db.orders.save", at: { line: 15 } });
    expect(t.from).toEqual(["paid"]);
  });

  it("B4: payment_succeeded is unconstrained, still atomic, still sends the receipt", () => {
    const t = transitionOf(variant("b4-webhook-dup"), "payment_succeeded");
    expect(t.sites?.fromState.unconstrained).toBe(true);
    expect(t.from).toEqual(orderModel().entity.states);
    expect(t.atomic).toBe(true);
    expect(t.effects.map((e) => e.name)).toEqual(["email.receipt"]);
  });

  it("B5: expire calls stripe.refund", () => {
    const t = transitionOf(variant("b5-undeclared-effect"), "expire");
    expect(t.effects).toEqual([{ name: "stripe.refund", multiplicity: "exactly-once" }]);
    expect(t.sites?.effects.map((e) => e.gate)).toEqual(["stripe.refunds.create"]);
  });

  it("B6: the code is the clean code, so the code model is identical", () => {
    expect(variant("b6-spec-race").model).toEqual(clean.model);
    expect(variant("b6-spec-race").findings).toEqual([]);
  });
});
