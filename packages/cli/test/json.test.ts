import { describe, expect, it } from "vitest";
import type { JsonReport } from "../src/output/json";
import { CANONICAL_DIR, CANONICAL_SPEC, INVALID_SPEC, tsv } from "./run";
import { b6VariantText, invalidSpecText, tempSpecDir } from "./temp-specs";

function parse(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

describe("--format json", () => {
  it("check: a clean canonical spec", async () => {
    const r = await tsv(["check", "--format", "json", CANONICAL_DIR]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(parse(r.stdout)).toEqual({
      version: 1,
      findings: [],
      specs: [
        {
          file: CANONICAL_SPEC,
          behavior: "Order lifecycle",
          stats: { states: 6, edges: 5, complete: true, boundLimitedDeadlocks: 0 },
        },
      ],
      summary: { errors: 0, warnings: 0 },
    });
  });

  it("check: the B6 variant reports effect multiplicity with a trace, and nothing else on stdout", async () => {
    const cwd = await tempSpecDir({ "order.behavior.yaml": await b6VariantText() });
    const r = await tsv(["check", "--format", "json"], { cwd, isTTY: true });
    expect(r.code).toBe(1);
    const doc = parse(r.stdout);
    expect(doc.version).toBe(1);
    expect(doc.summary).toEqual({ errors: 2, warnings: 0 });
    expect(doc.specs).toEqual([
      { file: "order.behavior.yaml", behavior: "Order lifecycle", stats: expect.any(Object) },
    ]);

    const multiplicity = doc.findings.find((f) => f.property === "effect-multiplicity");
    expect(multiplicity).toMatchObject({
      id: "spec-property:Order lifecycle:effect-multiplicity:stripe.refund",
      category: "spec-property",
      severity: "error",
      behavior: "Order lifecycle",
      specAt: { file: "order.behavior.yaml", line: 58, column: 9 },
    });
    expect(multiplicity?.trace?.steps.length).toBeGreaterThan(1);
    // No pretty-output leakage: no note, no colors.
    expect(r.stdout).not.toContain("note:");
    expect(r.stdout).not.toContain(String.fromCharCode(27));
  });

  it("check: mixed input keeps invalid input precedence and lists both specs", async () => {
    const cwd = await tempSpecDir({
      "a/order.behavior.yaml": await b6VariantText(),
      "b/typo.behavior.yaml": await invalidSpecText(),
    });
    const r = await tsv(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(2);
    const doc = parse(r.stdout);
    expect(doc.specs.map((s) => [s.file, s.behavior, s.stats !== undefined])).toEqual([
      ["a/order.behavior.yaml", "Order lifecycle", true],
      ["b/typo.behavior.yaml", "Typo", false],
    ]);
    expect(doc.findings.map((f) => f.category)).toEqual([
      "spec-property",
      "spec-property",
      "invalid-spec",
    ]);
    expect(doc.summary).toEqual({ errors: 3, warnings: 0 });
  });

  it("validate: reports invalid-spec findings with cwd-relative locations", async () => {
    const r = await tsv(["validate", "--format", "json", INVALID_SPEC]);
    expect(r.code).toBe(2);
    const doc = parse(r.stdout);
    expect(doc.specs).toEqual([{ file: INVALID_SPEC, behavior: "Typo" }]);
    expect(doc.findings).toHaveLength(1);
    expect(doc.findings[0]).toMatchObject({
      category: "invalid-spec",
      severity: "error",
      specAt: { file: INVALID_SPEC, line: 18, column: 9 },
    });
    expect(doc.summary).toEqual({ errors: 1, warnings: 0 });
  });

  it("is deterministic", async () => {
    const a = await tsv(["check", "--format", "json", CANONICAL_DIR]);
    const b = await tsv(["check", "--format", "json", CANONICAL_DIR]);
    expect(a.stdout).toBe(b.stdout);
  });

  it("rejects an unknown format with exit 2", async () => {
    const r = await tsv(["check", "--format", "xml", CANONICAL_DIR]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--format must be one of pretty, json (got xml)");
  });
});
