/**
 * The extractor reads code with the project's own TypeScript (5.4–6.x, or
 * `@typescript/typescript6`). The default suite runs on `@typescript/typescript6`, which this TS-7
 * monorepo resolves to; here the golden code models must come out byte-identical on TypeScript
 * 5.9 too. (`versions.config.ts` runs the whole suite on one version.)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BehaviorModel } from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";
import { parseSpec } from "@tsverify/spec";
import { describe, expect, it } from "vitest";
import { APP_ROOT as ORDERS_APP } from "../../../examples/orders-app/test/materialize";
import { APP_ROOT as ORDERS_PRISMA } from "../../../examples/orders-prisma/test/materialize";
import { extractAll, type TypeScript } from "../src/index";

const TS59 = createRequire(import.meta.url)("typescript59") as TypeScript;
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
] as const)("%s on TypeScript 5.9", (name, root, spec) => {
  it("matches the golden code model", () => {
    expect(TS59.version).toMatch(/^5\.9\./);
    const { results } = extractAll([spec()], { projectRoot: root, typescript: TS59 });
    const golden = readFileSync(new URL(`${name}.code.json`, GOLDEN), "utf8");
    expect(results[0]?.findings).toEqual([]);
    expect(`${JSON.stringify(results[0]?.model, null, 2)}\n`).toBe(golden);
  });
});
