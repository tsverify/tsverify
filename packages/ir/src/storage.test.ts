import { describe, expect, it } from "vitest";
import { defaultStorageArgs, formatStorageFunction, storageFunctions } from "./storage";

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

  it("lists every function with its kind", () => {
    const fn = { ref, args: [] };
    expect(
      storageFunctions({ key: "id", read: [fn], save: [], update: [fn], atomic: [fn] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["read", "update", "atomic"]);
  });
});
