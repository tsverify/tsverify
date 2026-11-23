import { describe, expect, it } from "vitest";
import {
  formatGuardArgList,
  formatGuardRef,
  parseGuardArgs,
  parseGuardBinding,
  parseGuardRef,
  parseSymbolRef,
} from "./refs";

describe("parseSymbolRef", () => {
  it("reads a private method of a class (`Class.#method`), but not a private head", () => {
    expect(parseSymbolRef("src/queue.ts#Queue.#moveToFallback")).toEqual({
      file: "src/queue.ts",
      symbol: "Queue.#moveToFallback",
    });
    expect(parseSymbolRef("src/queue.ts##moveToFallback")).toBeUndefined();
    expect(parseSymbolRef("src/queue.ts#Queue.#")).toBeUndefined();
  });
});

describe("parseSymbolRef", () => {
  it("parses file#symbol", () => {
    expect(parseSymbolRef("src/orders/refund.ts#refundOrder")).toEqual({
      file: "src/orders/refund.ts",
      symbol: "refundOrder",
    });
  });
  it("accepts dotted members", () => {
    expect(parseSymbolRef("src/svc.ts#OrderService.refund")?.symbol).toBe("OrderService.refund");
  });
  it.each(["src/a.ts", "#fn", "src/a.ts#", "src/a.ts#1bad", "a b.ts#fn"])("rejects %s", (t) => {
    expect(parseSymbolRef(t)).toBeUndefined();
  });
});

describe("parseGuardRef", () => {
  it("parses a bare guard", () => {
    expect(parseGuardRef("owner")).toEqual({ name: "owner", args: [], raw: "owner" });
  });
  it("parses and canonicalises arguments", () => {
    expect(parseGuardRef("role( admin )")).toEqual({
      name: "role",
      args: ["admin"],
      raw: "role(admin)",
    });
    expect(formatGuardRef({ name: "scope", args: ["a", "b"] })).toBe("scope(a, b)");
  });
  it("rejects malformed guards", () => {
    expect(parseGuardRef("role(admin")).toBeUndefined();
  });
});

describe("parseGuardBinding", () => {
  it("parses a binding with quoted args", () => {
    expect(parseGuardBinding('src/auth/guards.ts#requireRole("admin")')).toEqual({
      file: "src/auth/guards.ts",
      symbol: "requireRole",
      args: ["admin"],
      raw: 'src/auth/guards.ts#requireRole("admin")',
    });
  });
  it("parses a binding without args", () => {
    expect(parseGuardBinding("src/auth/guards.ts#requireOwner")?.args).toEqual([]);
  });
  it("reads a list argument the same whatever the quotes and spacing", () => {
    const canonical = ['["owner", "admin"]'];
    expect(parseGuardBinding('src/a.ts#requireRole(["owner", "admin"])')?.args).toEqual(canonical);
    expect(parseGuardBinding("src/a.ts#requireRole(['owner','admin'])")?.args).toEqual(canonical);
    expect(parseGuardBinding("src/a.ts#requireRole([owner, admin])")?.args).toEqual(canonical);
    expect(parseGuardBinding("src/a.ts#requireRole([])")?.args).toEqual(["[]"]);
  });
  it("reads scalars and lists side by side", () => {
    expect(parseGuardArgs(`'admin', 2, ["a,b", 'c'], true`)).toEqual([
      "admin",
      "2",
      '["a,b", "c"]',
      "true",
    ]);
    expect(formatGuardArgList(["owner", "admin"])).toBe('["owner", "admin"]');
  });
  it.each([
    'src/a.ts#requireRole({ role: "admin" })',
    "src/a.ts#requireRole(roles())",
    'src/a.ts#requireRole("admin)',
    "src/a.ts#requireRole([[a]])",
    "src/a.ts#requireRole([a b] c)",
    "src/a.ts#requireRole(a,,b)",
  ])("rejects arguments it can't match: %s", (t) => {
    expect(parseGuardBinding(t)).toBeUndefined();
  });
});
