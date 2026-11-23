import type { Finding } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { displayLocations, displayPath, rebaseFile, rebaseLocations } from "./locations";

const CWD = "/work";
const ROOT = "/work/apps/shop";

describe("rebaseFile", () => {
  it.each([
    ["src/a.ts", ROOT, CWD, "apps/shop/src/a.ts"],
    ["src/a.ts", CWD, CWD, "src/a.ts"],
    ["../specs/o.behavior.yaml", ROOT, CWD, "apps/specs/o.behavior.yaml"],
    ["apps/shop/src/a.ts", CWD, ROOT, "src/a.ts"],
    ["specs/o.behavior.yaml", CWD, ROOT, "../../specs/o.behavior.yaml"],
    ["/elsewhere/x.ts", ROOT, CWD, "../elsewhere/x.ts"],
    [".", ROOT, ROOT, "."],
  ])("%s from %s to %s → %s", (file, from, to, expected) => {
    expect(rebaseFile(file, from, to)).toBe(expected);
  });
});

describe("rebaseLocations", () => {
  const finding: Finding = {
    id: "non-atomic:Order lifecycle:refund",
    category: "non-atomic",
    severity: "error",
    message: "refund: …",
    specAt: { file: "../specs/order.behavior.yaml", line: 52, column: 3, endLine: 59 },
    codeAt: { file: "src/orders/refund.ts", line: 10, column: 23 },
  };

  it("rebases specAt and codeAt without touching the input", () => {
    const before = structuredClone(finding);
    const [out] = rebaseLocations([finding], ROOT, CWD);
    expect(out).toEqual({
      ...finding,
      specAt: { file: "apps/specs/order.behavior.yaml", line: 52, column: 3, endLine: 59 },
      codeAt: { file: "apps/shop/src/orders/refund.ts", line: 10, column: 23 },
    });
    expect(finding).toEqual(before);
    expect(out?.codeAt).not.toBe(finding.codeAt);
  });

  it("rebases nested locations (model sites) but not symbol refs", () => {
    const sites = {
      impl: { file: "src/orders/refund.ts", symbol: "refundOrder" },
      write: { file: "src/orders/refund.ts", line: 14, column: 3 },
      guards: [{ guard: "owner", at: { file: "src/auth/guards.ts", line: 1, column: 1 } }],
    };
    expect(rebaseLocations(sites, ROOT, CWD)).toEqual({
      impl: { file: "src/orders/refund.ts", symbol: "refundOrder" },
      write: { file: "apps/shop/src/orders/refund.ts", line: 14, column: 3 },
      guards: [
        { guard: "owner", at: { file: "apps/shop/src/auth/guards.ts", line: 1, column: 1 } },
      ],
    });
  });

  it("round-trips", () => {
    const there = rebaseLocations(finding, ROOT, CWD);
    expect(rebaseLocations(there, CWD, ROOT)).toEqual(finding);
  });

  it("returns the value itself when the directories are the same", () => {
    expect(rebaseLocations(finding, CWD, "/work/")).toBe(finding);
  });
});

describe("displayPath / displayLocations (pretty output)", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    [".", "."],
    ["..", "/"],
    ["../other/a.ts", "/other/a.ts"],
    ["../../x/b.yaml", "/x/b.yaml"],
    ["..foo/a.ts", "..foo/a.ts"],
  ])("%s → %s", (file, expected) => {
    expect(displayPath(file, CWD)).toBe(expected);
  });

  it("makes locations outside the cwd absolute, and leaves the rest", () => {
    const finding: Finding = {
      id: "x",
      category: "non-atomic",
      severity: "error",
      message: "…",
      specAt: { file: "../specs/o.behavior.yaml", line: 1, column: 1 },
      codeAt: { file: "src/a.ts", line: 2, column: 3 },
    };
    expect(displayLocations([finding], CWD)[0]).toEqual({
      ...finding,
      specAt: { file: "/specs/o.behavior.yaml", line: 1, column: 1 },
    });
  });
});
