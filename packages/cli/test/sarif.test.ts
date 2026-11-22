import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORY_DESCRIPTIONS, FINGERPRINT_KEY, type SarifLog } from "../src/output/sarif";
import { CANONICAL_SPEC, tsverify } from "./run";
import { SARIF_SUBSET, validate } from "./sarif-schema";
import { b6VariantText, invalidSpecText, tempSpecDir } from "./temp-specs";

function parse(stdout: string): SarifLog {
  const log = JSON.parse(stdout) as SarifLog;
  expect(validate(log, SARIF_SUBSET)).toEqual([]);
  return log;
}

describe("--format sarif", () => {
  it("check: a spec-model counterexample becomes a located, fingerprinted result", async () => {
    const cwd = await tempSpecDir({ "specs/order.behavior.yaml": await b6VariantText() });
    const r = await tsverify(["check", "--spec-only", "--format", "sarif"], { cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    const [run] = parse(r.stdout).runs;
    expect(run.tool.driver.name).toBe("tsverify");
    expect(run.originalUriBaseIds).toEqual({
      "%SRCROOT%": { uri: `${pathToFileURL(cwd).href}/` },
    });
    const result = run.results.find(
      (x) =>
        x.partialFingerprints[FINGERPRINT_KEY] ===
        "spec-property:Order lifecycle:effect-multiplicity:stripe.refund",
    );
    expect(result).toMatchObject({
      ruleId: "spec-property",
      level: "error",
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: "specs/order.behavior.yaml", uriBaseId: "%SRCROOT%" },
            region: { startLine: 58, startColumn: 9 },
          },
        },
      ],
      properties: { behavior: "Order lifecycle", property: "effect-multiplicity" },
    });
    // No code site: the spec is the primary location and there is nothing related.
    expect(result?.relatedLocations).toBeUndefined();
    expect(result?.properties.trace?.steps[0]).toBe("step 0  status=draft");
    expect(result?.properties.trace?.steps.at(-1)).toMatch(/✗ effect-multiplicity$/);
    expect(result?.properties.enforced).toBeUndefined();
  });

  it("lists every finding category as a rule, and ruleIndex points at the result's rule", async () => {
    const cwd = await tempSpecDir({ "order.behavior.yaml": await b6VariantText() });
    const [run] = parse(
      (await tsverify(["check", "--spec-only", "--format", "sarif"], { cwd })).stdout,
    ).runs;
    const rules = run.tool.driver.rules;
    expect(rules.map((rule) => rule.id)).toEqual(Object.keys(CATEGORY_DESCRIPTIONS));
    expect(rules.find((rule) => rule.id === "non-atomic")?.name).toBe("NonAtomic");
    for (const result of run.results) {
      expect(rules[result.ruleIndex]?.id).toBe(result.ruleId);
    }
  });

  it("carries enforced on the results of enforced specs", async () => {
    const text = (await b6VariantText()).replace(
      "behavior: Order lifecycle\n",
      "$&enforced: true\n",
    );
    const cwd = await tempSpecDir({ "order.behavior.yaml": text });
    const [run] = parse(
      (await tsverify(["check", "--spec-only", "--format", "sarif"], { cwd })).stdout,
    ).runs;
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results.every((x) => x.properties.enforced === true)).toBe(true);
  });

  it("validate: an invalid spec is an error result at its YAML location (exit 2)", async () => {
    const cwd = await tempSpecDir({ "typo.behavior.yaml": await invalidSpecText() });
    const r = await tsverify(["validate", "--format", "sarif"], { cwd });
    expect(r.code).toBe(2);
    const [run] = parse(r.stdout).runs;
    expect(run.results).toEqual([
      expect.objectContaining({
        ruleId: "invalid-spec",
        level: "error",
        locations: [
          expect.objectContaining({
            physicalLocation: expect.objectContaining({
              region: expect.objectContaining({ startLine: 18, startColumn: 9 }),
            }),
          }),
        ],
      }),
    ]);
  });

  it("is empty but valid for a clean spec", async () => {
    const r = await tsverify(["check", "--spec-only", "--format", "sarif", CANONICAL_SPEC]);
    expect(r.code).toBe(0);
    expect(parse(r.stdout).runs[0].results).toEqual([]);
    // Output never depends on timing: two runs are identical.
    const again = await tsverify(["check", "--spec-only", "--format", "sarif", CANONICAL_SPEC]);
    expect(again.stdout).toBe(r.stdout);
  });
});

describe("SARIF subset validator", () => {
  it("rejects what code scanning would reject", () => {
    const log = {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "tsverify" } },
          results: [{ ruleId: "x", message: {}, locations: [], level: "fatal" }],
        },
      ],
    };
    expect(validate(log, SARIF_SUBSET)).toEqual([
      "$.runs[0].results[0].message: missing text",
      "$.runs[0].results[0].locations: fewer than 1 items",
      '$.runs[0].results[0].level: "fatal" not in ["none","note","warning","error"]',
    ]);
  });
});
