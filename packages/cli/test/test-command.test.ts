/**
 * `tsverify test` in-process, for the cases that never start vitest (nothing to run, invalid input).
 * Runs against the orders app are in e2e/test-command.test.ts (subprocess).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonReport } from "../src/output/json";
import { tsverify } from "./run";
import { invalidSpecText, tempSpecDir } from "./temp-specs";

const SPEC = `behavior: Light switch
entity:
  name: Light
  state: status
  states: [off, on]
  initial: off
  terminal: [on]
actors:
  user: { trust: authenticated }
transitions:
  switch_on:
    from: off
    to: on
    by: user
    impl: src/light.ts#switchOn
`;

const CODE = `export interface Light {
  id: string;
  status: "off" | "on";
}

export function switchOn(light: Light): void {
  if (light.status !== "off") throw new Error("not off");
  light.status = "on";
}
`;

const PROJECT = {
  "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n`,
  "src/light.ts": CODE,
  "src/light.behavior.yaml": SPEC,
};

describe("tsverify test", () => {
  it("is listed in the help", async () => {
    const r = await tsverify(["test", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("$ tsverify test [...paths] [options]");
    expect(r.stdout).toContain(".tsverify/generated/");
  });

  it("explains what it cannot generate and runs nothing", async () => {
    const cwd = await tempSpecDir(PROJECT);
    const r = await tsverify(["test", "--format", "json"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as JsonReport;
    expect(doc.findings).toEqual([
      expect.objectContaining({
        id: "not-generated:Light switch:testgen:fixtures",
        category: "not-generated",
        severity: "info",
      }),
    ]);
    expect(doc.specs).toEqual([
      {
        file: "src/light.behavior.yaml",
        behavior: "Light switch",
        project: ".",
        generated: {
          dir: ".tsverify/generated/light-switch",
          tests: { total: 0, passed: 0, failed: 0, missing: 0 },
        },
      },
    ]);
    expect(await readdir(join(cwd, ".tsverify/generated/light-switch"))).toEqual([]);
  });

  it("reports only generated-test findings, and says so in pretty output", async () => {
    // `smash` has no impl, so `tsverify check` reports a static (conformance) info finding that
    // `tsverify test` must leave out.
    const spec = SPEC.replace("states: [off, on]", "states: [off, on, broken]")
      .replace("terminal: [on]", "terminal: [on, broken]")
      .concat("  smash:\n    from: off\n    to: broken\n    by: user\n");
    const cwd = await tempSpecDir({ ...PROJECT, "src/light.behavior.yaml": spec });
    const check = await tsverify(["check", "--format", "json"], { cwd });
    const messages = (JSON.parse(check.stdout) as JsonReport).findings.map((f) => f.message);
    expect(messages).toContain(
      "smash: not linked to code (no impl), so it is not checked against the code.",
    );
    const r = await tsverify(["test"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "src/light.behavior.yaml  project: . · .tsverify/generated/light-switch: 0 tests, 0 passed",
    );
    expect(r.stdout).toContain(
      "Generated-test results only: static findings (model checking, conformance) come from `tsverify check`.",
    );
    expect(r.stdout).toMatch(/✓ 1 spec, 0 generated tests, 0 errors, 0 warnings\n$/);
    expect(r.stdout).not.toContain("not linked to code");
  });

  it("exits 2 on an invalid spec", async () => {
    const cwd = await tempSpecDir({
      ...PROJECT,
      "src/typo.behavior.yaml": await invalidSpecText(),
    });
    const r = await tsverify(["test", "src/typo.behavior.yaml", "--format", "json"], { cwd });
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.stdout) as JsonReport;
    expect(doc.findings.map((f) => f.category)).toEqual(["invalid-spec"]);
  });

  it("rejects a bad --format with exit 2", async () => {
    const r = await tsverify(["test", "--format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--format must be one of pretty, json");
  });
});
