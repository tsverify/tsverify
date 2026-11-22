/**
 * `tsv test` in-process, for the cases that never start vitest (nothing to run, invalid input).
 * Runs against the orders app are in e2e/test-command.test.ts (subprocess).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonReport } from "../src/output/json";
import { tsv } from "./run";
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

describe("tsv test", () => {
  it("is listed in the help", async () => {
    const r = await tsv(["test", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("$ tsv test [...paths] [options]");
    expect(r.stdout).toContain(".tsv/generated/");
  });

  it("explains what it cannot generate and runs nothing", async () => {
    const cwd = await tempSpecDir(PROJECT);
    const r = await tsv(["test", "--format", "json"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as JsonReport;
    expect(doc.findings).toEqual([
      expect.objectContaining({
        id: "unanalyzable:Light switch:testgen:fixtures",
        category: "unanalyzable",
        severity: "info",
      }),
    ]);
    expect(doc.specs).toEqual([
      {
        file: "src/light.behavior.yaml",
        behavior: "Light switch",
        project: ".",
        generated: {
          dir: ".tsv/generated/light-switch",
          tests: { total: 0, passed: 0, failed: 0, missing: 0 },
        },
      },
    ]);
    expect(await readdir(join(cwd, ".tsv/generated/light-switch"))).toEqual([]);
  });

  it("reports only generated-test findings, and says so in pretty output", async () => {
    // switchOn has no client calls, so `tsv check` reports info findings that `tsv test` leaves out.
    const cwd = await tempSpecDir(PROJECT);
    const check = await tsv(["check", "--format", "json"], { cwd });
    expect((JSON.parse(check.stdout) as JsonReport).findings.length).toBeGreaterThan(0);
    const r = await tsv(["test"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "src/light.behavior.yaml  project: . · .tsv/generated/light-switch: 0 tests, 0 passed",
    );
    expect(r.stdout).toContain(
      "Generated-test results only: static findings (model checking, conformance) come from `tsv check`.",
    );
    expect(r.stdout).toMatch(/✓ 1 spec, 0 generated tests, 0 errors, 0 warnings\n$/);
  });

  it("exits 2 on an invalid spec", async () => {
    const cwd = await tempSpecDir({
      ...PROJECT,
      "src/typo.behavior.yaml": await invalidSpecText(),
    });
    const r = await tsv(["test", "src/typo.behavior.yaml", "--format", "json"], { cwd });
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.stdout) as JsonReport;
    expect(doc.findings.map((f) => f.category)).toEqual(["invalid-spec"]);
  });

  it("rejects a bad --format with exit 2", async () => {
    const r = await tsv(["test", "--format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--format must be one of pretty, json");
  });
});
