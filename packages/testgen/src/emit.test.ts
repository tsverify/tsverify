import type { InvocationShape } from "@tsv/ir";
import { describe, expect, it } from "vitest";
import { literal, Names, relativeImport } from "./emit";
import { buildArgs } from "./invoke";

describe("relativeImport", () => {
  it("goes from the generated directory to a project file", () => {
    expect(relativeImport(".tsv/generated/order-lifecycle", "src/db.ts")).toBe(
      "../../../src/db.ts",
    );
    expect(relativeImport("gen", "gen/x.json")).toBe("./x.json");
    expect(relativeImport("a/b", "a/c/d.ts")).toBe("../c/d.ts");
    expect(relativeImport("./a/", "./a/./b/../c.ts")).toBe("./c.ts");
  });
});

describe("literal", () => {
  it("prints JSON-like values as single-line code", () => {
    expect(literal({ id: "o1", "odd-key": [1, true, null], nested: {} })).toBe(
      '{ id: "o1", "odd-key": [1, true, null], nested: {} }',
    );
  });
  it("substitutes placeholders", () => {
    const replace = (v: unknown) => (v === "$id" ? "ID" : undefined);
    expect(literal([{ orderId: "$id" }], replace)).toBe("[{ orderId: ID }]");
  });
});

describe("Names", () => {
  it("avoids reserved and used names", () => {
    const names = new Names(["s", "db"]);
    expect(names.allocate("db")).toBe("db_2");
    expect(names.allocate("my-client")).toBe("my_client");
    expect(names.allocate("delete")).toBe("delete_2");
    expect(names.allocate("1st")).toBe("_1st");
  });
});

describe("buildArgs", () => {
  const shape: InvocationShape = {
    impl: { file: "src/orders/refund.ts", symbol: "refundOrder" },
    entityId: { param: 1, path: [] },
    actor: { param: 0, path: ["actor"] },
  };

  it("builds the arguments from the invocation shape", () => {
    expect(buildArgs(shape, undefined, "admin")).toEqual({
      ok: true,
      args: "{ actor: ACTORS.admin }, ID",
    });
    expect(
      buildArgs({ ...shape, entityId: { param: 0, path: ["order", "id"] } }, undefined, "admin"),
    ).toEqual({ ok: true, args: "{ order: { id: ID }, actor: ACTORS.admin }" });
  });

  it("prefers fixtures.args, substituting $id and $actor", () => {
    expect(buildArgs(shape, [{ by: "$actor", order: "$id" }, 3], "customer")).toEqual({
      ok: true,
      args: "{ by: ACTORS.customer, order: ID }, 3",
    });
  });

  it("reports a conflicting shape", () => {
    const result = buildArgs({ ...shape, actor: { param: 1, path: [] } }, undefined, "admin");
    expect(result.ok).toBe(false);
  });
});
