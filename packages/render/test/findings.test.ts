import { type Formatter, formatFindings, plainFormatter } from "@tsv/render";
import { describe, expect, it } from "vitest";
import { SAMPLE_CWD, sampleFindings } from "./sample-findings";

/** Wraps each styled span in `<name>…</name>`, so goldens show exactly what gets colored. */
const taggingFormatter: Formatter = {
  bold: (s) => `<bold>${s}</bold>`,
  dim: (s) => `<dim>${s}</dim>`,
  red: (s) => `<red>${s}</red>`,
  yellow: (s) => `<yellow>${s}</yellow>`,
  green: (s) => `<green>${s}</green>`,
  cyan: (s) => `<cyan>${s}</cyan>`,
};

describe("formatFindings", () => {
  it("formats a mixed list as plain text", async () => {
    const out = formatFindings(sampleFindings(), { cwd: SAMPLE_CWD });
    await expect(out).toMatchFileSnapshot("__golden__/findings-plain.txt");
  });

  it("applies colors through the formatter", async () => {
    const out = formatFindings(sampleFindings(), { cwd: SAMPLE_CWD, formatter: taggingFormatter });
    expect(out).toContain("<bold>Order lifecycle</bold>\n");
    expect(out).toContain(
      "  <red>✗ spec-property</red>  <dim>src/orders/order.behavior.yaml:52:5</dim>",
    );
    expect(out).toContain("  <yellow>⚠ non-atomic</yellow>");
    expect(out).toContain("  <cyan>ℹ unanalyzable</cyan>");
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "<red>3 errors</red><dim> · </dim><yellow>3 warnings</yellow><dim> · </dim><cyan>1 info</cyan>",
    );
    await expect(out).toMatchFileSnapshot("__golden__/findings-tagged.txt");
  });

  it("groups by behavior, then orders by severity, location and id", () => {
    const out = formatFindings(sampleFindings());
    const headlines = out.split("\n").filter((l) => /^ {2}\S/.test(l) || /^\S/.test(l));
    expect(headlines.map((l) => l.trim().split("  ")[0])).toEqual([
      "Inventory",
      "⚠ spec-property",
      "Order lifecycle",
      "✗ guard-not-dominating",
      "✗ spec-property",
      "⚠ non-atomic",
      "⚠ spec-property",
      "ℹ unanalyzable",
      "(no behavior)",
      "✗ invalid-spec",
      "3 errors · 3 warnings · 1 info",
    ]);
  });

  it("shows locations relative to cwd only when they are under it", () => {
    const out = formatFindings(sampleFindings(), { cwd: "/repo/" });
    expect(out).toContain("src/orders/order.behavior.yaml:50:5 · src/orders/refund.ts:12:3");
    expect(out).toContain("/elsewhere/inventory.behavior.yaml:8:3");
    expect(formatFindings(sampleFindings(), { cwd: "/rep" })).toContain(
      "/repo/src/bad.behavior.yaml:3:9",
    );
  });

  it("reports an empty list", () => {
    expect(formatFindings([])).toBe("✓ no findings\n");
    expect(formatFindings([], { formatter: taggingFormatter })).toBe(
      "<green>✓ no findings</green>\n",
    );
  });

  it("is the identity with plainFormatter", () => {
    for (const fn of Object.values(plainFormatter)) expect(fn("x")).toBe("x");
  });
});
