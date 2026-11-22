import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { orderModel, stripLocations } from "@tsverify/ir/testing";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/index";

const FILE = "test/fixtures/valid/order.behavior.yaml";
const text = readFileSync(fileURLToPath(new URL(`../${FILE}`, import.meta.url)), "utf8");

describe("canonical order.behavior.yaml", () => {
  const { model, findings } = parseSpec(text, FILE);

  it("has no findings", () => {
    expect(findings).toEqual([]);
  });

  it("normalizes to the shared IR fixture (contract with @tsverify/ir/testing)", () => {
    expect(model).toBeDefined();
    const { file, ...rest } = stripItemLocations(stripLocations(model)) as NonNullable<
      typeof model
    >;
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
    expect(refund?.at).toEqual(at(52, 3));
    expect(refund?.effects[0]?.at).toEqual(at(58, 9));
    expect(model.rules[2]?.at).toEqual(at(66, 5));
    expect(model.bindings.clients.stripe?.at).toEqual(at(78, 5));
    expect(model.bindings.guards["role(admin)"]?.at).toEqual(at(82, 5));
  });

  it("locates every from / by / requires item and every bindings.effects entry", () => {
    if (!model) throw new Error("no model");
    const at = (line: number, column: number, endColumn: number) =>
      ({ file: FILE, line, column, endLine: line, endColumn }) as const;
    const t = (name: string) => model.transitions.find((x) => x.name === name);
    expect(t("checkout")?.fromAt).toEqual([at(20, 11, 16)]);
    expect(t("checkout")?.byAt).toEqual([at(22, 9, 17)]);
    expect(t("checkout")?.requires[0]?.at).toEqual(at(23, 16, 21));
    expect(t("refund")?.byAt).toEqual([at(55, 9, 14)]);
    expect(model.actors.admin?.requires[0]?.at).toEqual(at(14, 44, 55));
    expect(model.bindings.effectsAt).toEqual({
      "email.receipt": at(85, 5, 30),
      "stripe.refund": at(84, 5, 41),
    });
  });

  it('omits fromAt for from: "*" and aligns it with a from list', () => {
    const star = parseSpec(
      text.replace("from: paid\n    to: shipped", 'from: "*"\n    to: shipped'),
      FILE,
    );
    expect(star.model?.transitions.find((x) => x.name === "ship")?.fromAt).toBeUndefined();
    const list = parseSpec(
      text.replace(
        "from: pending_payment\n    to: cancelled",
        "from: [draft, pending_payment]\n    to: cancelled",
      ),
      FILE,
    );
    const expire = list.model?.transitions.find((x) => x.name === "expire");
    expect(expire?.from).toEqual(["draft", "pending_payment"]);
    expect(expire?.fromAt?.map((l) => [l.line, l.column])).toEqual([
      [38, 12],
      [38, 19],
    ]);
  });
});

/** `stripLocations` drops `at` keys; the per-item location lists and maps go too. */
function stripItemLocations<T>(value: T): T {
  const keys = new Set(["fromAt", "byAt", "effectsAt"]);
  return JSON.parse(JSON.stringify(value, (key, v) => (keys.has(key) ? undefined : v))) as T;
}
