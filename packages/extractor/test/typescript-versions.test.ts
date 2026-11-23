/**
 * The extractor reads code with the project's own TypeScript 7. The default suite runs on the
 * monorepo's `typescript` (7.0, whose API is under `typescript/unstable/*`); here the golden code
 * models must come out byte-identical on TypeScript 7.1 too (stable `typescript/sync`, and a
 * different snapshot API). (`versions.config.ts` runs the whole suite on one version.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BehaviorModel } from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";
import { parseSpec } from "@tsverify/spec";
import { describe, expect, it } from "vitest";
import { APP_ROOT as ORDERS_APP } from "../../../examples/orders-app/test/materialize";
import { APP_ROOT as ORDERS_PRISMA } from "../../../examples/orders-prisma/test/materialize";
import { extractAll, loadTypeScriptPackage } from "../src/index";

const TS71 = loadTypeScriptPackage("typescript71", import.meta.url);
const GOLDEN = new URL("./__golden__/", import.meta.url);

function prismaSpec(): BehaviorModel {
  const file = "src/orders/order.behavior.yaml";
  const { model } = parseSpec(readFileSync(join(ORDERS_PRISMA, file), "utf8"), file);
  if (!model) throw new Error(`invalid spec ${file}`);
  return model;
}

describe.each([
  ["orders-app", ORDERS_APP, orderModel],
  ["orders-prisma", ORDERS_PRISMA, prismaSpec],
] as const)("%s on TypeScript 7.1", (name, root, spec) => {
  it("matches the golden code model", () => {
    if ("error" in TS71) throw new Error(TS71.error);
    expect(TS71.version).toMatch(/^7\.1\./);
    const { results } = extractAll([spec()], { projectRoot: root, typescript: TS71.ts });
    const golden = readFileSync(new URL(`${name}.code.json`, GOLDEN), "utf8");
    expect(results[0]?.findings).toEqual([]);
    expect(`${JSON.stringify(results[0]?.model, null, 2)}\n`).toBe(golden);
  });
});
