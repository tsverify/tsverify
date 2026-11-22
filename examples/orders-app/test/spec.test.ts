import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BehaviorModel } from "@tsverify/ir";
import { loadSpec } from "@tsverify/spec";
import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/actor";
import { ForbiddenError } from "../src/errors";
import type { Order } from "../src/orders/order";
import { admin, alice } from "./seed";

const APP = fileURLToPath(new URL("..", import.meta.url));
const SPEC = "src/orders/order.behavior.yaml";
const CANONICAL = fileURLToPath(
  new URL("../../../packages/spec/test/fixtures/valid/order.behavior.yaml", import.meta.url),
);

async function exportsOf(file: string): Promise<Record<string, unknown>> {
  return import(join(APP, file));
}

/** Follows `a.b.c` from `root`, or returns undefined when a segment is missing. */
function at(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

describe("order.behavior.yaml", () => {
  it("is byte-identical to the canonical fixture in @tsverify/spec", async () => {
    const [copy, canonical] = await Promise.all([readFile(join(APP, SPEC)), readFile(CANONICAL)]);
    expect(copy.equals(canonical)).toBe(true);
  });

  describe("resolves against the app", () => {
    let model: BehaviorModel;

    beforeAll(async () => {
      const result = await loadSpec(SPEC, { root: APP });
      expect(result.findings).toEqual([]);
      if (!result.model) throw new Error("spec did not load");
      model = result.model;
    });

    it("every impl is an exported function", async () => {
      expect(model.transitions.every((t) => t.impl !== undefined)).toBe(true);
      for (const { impl } of model.transitions) {
        if (!impl) continue;
        expect(
          typeof (await exportsOf(impl.file))[impl.symbol],
          `${impl.file}#${impl.symbol}`,
        ).toBe("function");
      }
    });

    it("every client binding is an exported object", async () => {
      for (const [name, client] of Object.entries(model.bindings.clients)) {
        expect(typeof (await exportsOf(client.module))[client.export], name).toBe("object");
      }
    });

    it("every effect binding is a function on a bound client", async () => {
      for (const [effect, path] of Object.entries(model.bindings.effects)) {
        const [clientName = "", ...member] = path.split(".");
        const client = model.bindings.clients[clientName];
        if (!client) throw new Error(`${effect}: no client ${clientName}`);
        const root = (await exportsOf(client.module))[client.export];
        expect(typeof at(root, member), `${effect} → ${path}`).toBe("function");
      }
    });

    it("every guard binding is an exported function that enforces its guard", async () => {
      const order: Order = { id: "o", ownerId: alice.id, email: "a@example.com", status: "draft" };
      // Guards are called as fn(actor, ...bound args, ...entity) and throw on denial.
      const cases: Record<string, { pass: Actor; fail: Actor; entity: unknown[] }> = {
        owner: { pass: alice, fail: admin, entity: [order] },
        "role(admin)": { pass: admin, fail: alice, entity: [] },
      };
      expect(Object.keys(model.bindings.guards).sort()).toEqual(Object.keys(cases).sort());
      for (const [guard, binding] of Object.entries(model.bindings.guards)) {
        const fn = (await exportsOf(binding.file))[binding.symbol];
        const c = cases[guard];
        if (typeof fn !== "function" || !c)
          throw new Error(`${guard}: ${binding.raw} not callable`);
        const call = (actor: Actor) => () => fn(actor, ...binding.args, ...c.entity);
        expect(call(c.pass), guard).not.toThrow();
        expect(call(c.fail), guard).toThrow(ForbiddenError);
      }
    });
  });
});
