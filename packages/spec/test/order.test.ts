import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { orderModel, stripLocations } from "@tsv/ir/testing";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/index";

const FILE = "test/fixtures/valid/order.behavior.yaml";
const text = readFileSync(fileURLToPath(new URL(`../${FILE}`, import.meta.url)), "utf8");

describe("canonical order.behavior.yaml", () => {
  const { model, findings } = parseSpec(text, FILE);

  it("has no findings", () => {
    expect(findings).toEqual([]);
  });

  it("normalizes to the shared IR fixture (contract with @tsv/ir/testing)", () => {
    expect(model).toBeDefined();
    const { file, ...rest } = stripLocations(model) as NonNullable<typeof model>;
    expect(file).toBe(FILE);
    expect(rest).toStrictEqual(orderModel());
  });

  it("matches the golden IR, including locations", async () => {
    await expect(`${JSON.stringify(model, null, 2)}\n`).toMatchFileSnapshot(
      "__golden__/order.ir.json",
    );
  });

  it("locates every element that has an `at` field", () => {
    if (!model) throw new Error("no model");
    const at = (line: number, column: number) =>
      expect.objectContaining({ file: FILE, line, column });
    expect(model.entity.at).toEqual(at(5, 1));
    expect(model.actors.admin?.at).toEqual(at(14, 3));
    const refund = model.transitions.find((t) => t.name === "refund");
    expect(refund?.at).toEqual(at(51, 3));
    expect(refund?.effects[0]?.at).toEqual(at(57, 9));
    expect(model.rules[2]?.at).toEqual(at(65, 5));
    expect(model.bindings.clients.stripe?.at).toEqual(at(77, 5));
    expect(model.bindings.guards["role(admin)"]?.at).toEqual(at(81, 5));
  });
});
