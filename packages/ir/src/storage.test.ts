import { describe, expect, it } from "vitest";
import {
  defaultStorageArgs,
  formatStorageArg,
  formatStorageFunction,
  storageFunctions,
  storageRoleAt,
  storageRoles,
} from "./storage";

const ref = { file: "src/repo.ts", symbol: "f" };

describe("storage functions", () => {
  it("has default roles per kind; update drops the roles its fixed states replace", () => {
    expect(defaultStorageArgs("read")).toEqual(["key"]);
    expect(defaultStorageArgs("save")).toEqual(["entity"]);
    expect(defaultStorageArgs("update")).toEqual(["key", "from", "to"]);
    expect(defaultStorageArgs("update", { from: ["paid"] })).toEqual(["key", "to"]);
    expect(defaultStorageArgs("update", { to: "paid" })).toEqual(["key", "from"]);
    expect(defaultStorageArgs("update", { from: ["a"], to: "b" })).toEqual(["key"]);
    expect(defaultStorageArgs("atomic")).toEqual(["callback"]);
  });

  it("formats only what differs from the defaults", () => {
    expect(formatStorageFunction("read", { ref, args: ["key"] })).toBe("src/repo.ts#f");
    expect(formatStorageFunction("save", { ref, args: ["key", "patch"] })).toBe(
      "src/repo.ts#f(key, patch)",
    );
    expect(
      formatStorageFunction("update", { ref, args: ["key", "from", "to"], returns: "changed" }),
    ).toBe("src/repo.ts#f");
    expect(
      formatStorageFunction("update", {
        ref,
        args: ["key"],
        from: ["a", "b"],
        to: "c",
        returns: "throws",
      }),
    ).toBe("src/repo.ts#f from [a, b] to c returns throws");
  });

  it("finds a role in a field of an object argument, and formats it as written", () => {
    const fn = {
      ref,
      args: [{ where: { id: "key" as const }, data: "patch" as const }, "_" as const],
    };
    expect(storageRoleAt(fn, "key")).toEqual({ index: 0, path: ["where", "id"] });
    expect(storageRoleAt(fn, "patch")).toEqual({ index: 0, path: ["data"] });
    expect(storageRoleAt(fn, "entity")).toBeUndefined();
    expect(storageRoles(fn)).toEqual(["key", "patch", "_"]);
    expect(formatStorageArg(fn.args[0] as never)).toBe("{ where: { id: key }, data: patch }");
    expect(formatStorageFunction("save", fn)).toBe(
      "src/repo.ts#f({ where: { id: key }, data: patch }, _)",
    );
  });

  it("lists every function with its kind", () => {
    const fn = { ref, args: [] };
    expect(
      storageFunctions({ key: "id", read: [fn], save: [], update: [fn], atomic: [fn] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["read", "update", "atomic"]);
  });
});
