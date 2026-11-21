import { describe, expect, it } from "vitest";
import { formatGuardRef, parseGuardBinding, parseGuardRef, parseSymbolRef } from "./refs";

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
});
