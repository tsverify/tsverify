import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BehaviorModel, Transition } from "@tsverify/ir";
import { compareStrings } from "@tsverify/ir";
import { parseSpec } from "@tsverify/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROOT, materialize } from "../../../examples/orders-prisma/test/materialize";
import { type ExtractResult, extractAll } from "../src/index";
import { guardKeys, transitionOf } from "./helpers";

const SPEC_FILE = "src/orders/order.behavior.yaml";

function specOf(root: string): BehaviorModel {
  const { model, findings } = parseSpec(readFileSync(join(root, SPEC_FILE), "utf8"), SPEC_FILE);
  if (!model) throw new Error(`invalid spec: ${JSON.stringify(findings)}`);
  return model;
}

function extractApp(root: string, spec = specOf(APP_ROOT)): ExtractResult {
  const { results } = extractAll([spec], { projectRoot: root });
  return results[0] as ExtractResult;
}

function requiredGuards(spec: BehaviorModel, t: Transition): string[] {
  const keys = new Set(t.requires.map((g) => g.raw));
  for (const by of t.by) for (const g of spec.actors[by]?.requires ?? []) keys.add(g.raw);
  return [...keys].sort(compareStrings);
}

/** Every write in the clean app is a conditional update; these also read the order first. */
const READS: Record<string, string | undefined> = {
  checkout: "prisma.order.findUniqueOrThrow",
  expire: undefined,
  payment_succeeded: undefined,
  refund: "prisma.order.findUniqueOrThrow",
  ship: "prisma.order.findUniqueOrThrow",
};
const COMMITS: Record<string, string> = {
  checkout: "prisma.order.update",
  expire: "prisma.order.updateMany",
  payment_succeeded: "prisma.order.updateMany",
  refund: "prisma.order.updateMany",
  ship: "prisma.order.update",
};

describe("orders-prisma (clean)", () => {
  const spec = specOf(APP_ROOT);
  const result = extractApp(APP_ROOT, spec);

  it("reports no findings and one code transition per spec transition", () => {
    expect(result.findings).toEqual([]);
    expect(result.model?.transitions.map((t) => t.name)).toEqual(
      spec.transitions.map((t) => t.name),
    );
  });

  it.each(specOf(APP_ROOT).transitions.map((t) => [t.name, t] as const))(
    "%s matches the spec as a conditional update",
    (name, t) => {
      const code = transitionOf(result, name);
      expect(code.sites?.persistence).toBe("prisma");
      expect(code.sites?.specTransition).toBe(name);
      expect(code.to).toBe(t.to);
      expect(code.from).toEqual(t.from);
      expect(code.sites?.fromState.unconstrained).toBe(false);
      expect(code.atomic).toBe(true);
      expect(code.sites?.atomic).toMatchObject({
        kind: "conditional-update",
        gate: COMMITS[name],
      });
      expect(code.sites?.commit?.gate).toBe(COMMITS[name]);
      expect(code.sites?.read?.gate).toBe(READS[name]);
      expect(guardKeys(code)).toEqual(requiredGuards(spec, t));
      expect(code.effects).toEqual(
        t.effects.map(({ name, multiplicity }) => ({ name, multiplicity })),
      );
      expect(code.sites?.invocation?.impl).toEqual(t.impl);
      expect(code.sites?.storage).toEqual({ client: "prisma", collection: "order", key: "id" });
    },
  );

  it("traces invocation arguments to the impl parameters, as for the assign app", () => {
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
      "__golden__/orders-prisma.code.json",
    );
  });
});

describe("orders-prisma variants", () => {
  const extracted = new Map<string, ExtractResult>();

  beforeAll(async () => {
    for (const id of [
      "b1-reopen",
      "b2-guard-bypass",
      "b3-refund-race",
      "b4-webhook-dup",
      "b5-undeclared-effect",
      "b7-tx-read-committed",
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

  it("B1: reopenOrder is an unlinked, atomic paid → pending_payment transition", () => {
    const t = transitionOf(variant("b1-reopen"), "reopenOrder");
    expect(t.sites?.specTransition).toBeUndefined();
    expect(t).toMatchObject({ from: ["paid"], to: "pending_payment", by: [], atomic: true });
  });

  it("B2: refund's role(admin) guard does not dominate", () => {
    const t = transitionOf(variant("b2-guard-bypass"), "refund");
    expect(guardKeys(t)).toEqual([]);
    expect(t.sites?.function.name).toBe("issueRefund");
    expect(t.atomic).toBe(true);
  });

  it("B3: read then plain update: not atomic, from the narrowed read", () => {
    const t = transitionOf(variant("b3-refund-race"), "refund");
    expect(t.atomic).toBe(false);
    expect(t.from).toEqual(["paid"]);
    expect(t.sites?.read?.gate).toBe("prisma.order.findUniqueOrThrow");
    expect(t.sites?.commit?.gate).toBe("prisma.order.update");
    expect(variant("b3-refund-race").findings).toEqual([]);
  });

  it("B4: a blind updateMany: unconstrained, still atomic, still sends the receipt", () => {
    const t = transitionOf(variant("b4-webhook-dup"), "payment_succeeded");
    expect(t.sites?.fromState.unconstrained).toBe(true);
    expect(t.from).toEqual(specOf(APP_ROOT).entity.states);
    expect(t.atomic).toBe(true);
    expect(t.effects.map((e) => e.name)).toEqual(["email.receipt"]);
  });

  it("B5: expire calls stripe.refund", () => {
    const t = transitionOf(variant("b5-undeclared-effect"), "expire");
    expect(t.effects).toEqual([{ name: "stripe.refund", multiplicity: "exactly-once" }]);
  });

  it("B7: read-then-update in a default-isolation $transaction is not atomic, with a note", () => {
    const t = transitionOf(variant("b7-tx-read-committed"), "refund");
    expect(t.atomic).toBe(false);
    expect(t.sites?.read?.gate).toBe("prisma.order.findUniqueOrThrow");
    expect(variant("b7-tx-read-committed").findings).toEqual([]);
    expect(t.sites?.atomicNote?.at).toMatchObject({ file: "src/orders/refund.ts", line: 14 });
    expect(t.sites?.atomicNote?.message).toContain("READ COMMITTED");
  });
});
