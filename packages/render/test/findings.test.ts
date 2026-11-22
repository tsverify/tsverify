import { type Formatter, formatFindings, plainFormatter } from "@tsverify/render";
import { describe, expect, it } from "vitest";
import { causedFindings, SAMPLE_CWD, sampleFindings } from "./sample-findings";

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

  it("omits the count line on request", () => {
    const withCount = formatFindings(sampleFindings(), { cwd: SAMPLE_CWD });
    const without = formatFindings(sampleFindings(), { cwd: SAMPLE_CWD, countLine: false });
    const lines = withCount.trimEnd().split("\n");
    expect(without).toBe(`${lines.slice(0, -2).join("\n")}\n`);
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

describe("formatFindings with groupCauses", () => {
  it("prints consequences under their cause, traces kept", async () => {
    const out = formatFindings(causedFindings(), { cwd: SAMPLE_CWD, groupCauses: true });
    await expect(out).toMatchFileSnapshot("__golden__/findings-grouped.txt");
    const headlines = out.split("\n").filter((l) => /^ +(✗|⚠|ℹ|↳)/.test(l));
    expect(headlines.map((l) => l.split("  src/")[0])).toEqual([
      "  ✗ non-atomic",
      "    ↳ consequence: ✗ implementation-property",
      "      ↳ consequence: ✗ replay-confirmed",
      "    ↳ consequence: ✗ implementation-property",
      "  ⚠ implementation-property",
    ]);
    // Consequences still count.
    expect(out.trimEnd().split("\n").at(-1)).toBe("4 errors · 1 warning · 0 info");
  });

  it("styles the consequence marker", async () => {
    const out = formatFindings(causedFindings(), {
      cwd: SAMPLE_CWD,
      groupCauses: true,
      formatter: taggingFormatter,
    });
    expect(out).toContain(
      "    <dim>↳ consequence:</dim> <red>✗ implementation-property</red>  <dim>src/orders/order.behavior.yaml:52:3 · src/orders/refund.ts:13:24</dim>",
    );
    await expect(out).toMatchFileSnapshot("__golden__/findings-grouped-tagged.txt");
  });

  it("is off by default: the same findings render flat", () => {
    const flat = formatFindings(causedFindings(), { cwd: SAMPLE_CWD });
    expect(flat).not.toContain("↳");
    expect(formatFindings(sampleFindings(), { cwd: SAMPLE_CWD, groupCauses: true })).toBe(
      formatFindings(sampleFindings(), { cwd: SAMPLE_CWD }),
    );
  });

  it("prints every finding once when causes form a cycle", () => {
    const [a, b] = causedFindings();
    if (!a || !b) throw new Error("sample too short");
    const cyclic = [
      { ...a, causedBy: [b.id] },
      { ...b, causedBy: [a.id] },
    ];
    const out = formatFindings(cyclic, { groupCauses: true, countLine: false });
    expect(out.split("\n").filter((l) => /^ +(↳ consequence: )?✗/.test(l))).toHaveLength(2);
    expect(out.split("↳").length - 1).toBe(1);
  });
});
