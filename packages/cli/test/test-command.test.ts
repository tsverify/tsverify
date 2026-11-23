/**
 * `tsverify test` in-process, for the cases that never start vitest (nothing to run, invalid input).
 * Runs against the orders app are in e2e/test-command.test.ts (subprocess).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { orderModel } from "@tsverify/ir/testing";
import { describe, expect, it } from "vitest";
import { strictUntested } from "../src/commands/test";
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
    // Nothing generated: no `generated`, and no directory.
    expect(doc.specs).toEqual([
      { file: "src/light.behavior.yaml", behavior: "Light switch", project: "." },
    ]);
    await expect(readdir(join(cwd, ".tsverify"))).rejects.toThrow(/ENOENT/);
  });

  it("removes the directory an earlier run left when it now generates nothing", async () => {
    const cwd = await tempSpecDir({
      ...PROJECT,
      ".tsverify/generated/light-switch/paths.test.ts": "// stale\n",
    });
    const r = await tsverify(["test", "--format", "json"], { cwd });
    expect(r.code).toBe(0);
    expect(await readdir(join(cwd, ".tsverify/generated"))).toEqual([]);
  });

  describe("--strict", () => {
    it("reports a transition with impl that got no test, and a spec that got none, as errors", async () => {
      const cwd = await tempSpecDir(PROJECT);
      const r = await tsverify(["test", "--strict", "--format", "json"], { cwd });
      expect(r.code).toBe(1);
      const doc = JSON.parse(r.stdout) as JsonReport;
      expect(doc.findings.map((f) => [f.id, f.severity, f.causedBy])).toEqual([
        ["not-generated:Light switch:testgen:fixtures", "error", undefined],
        [
          "not-generated:Light switch:strict:switch_on",
          "error",
          ["not-generated:Light switch:testgen:fixtures"],
        ],
      ]);
      expect(doc.findings[1]?.message).toBe(
        "switch_on: tsverify test generated no test for it, so its impl (switchOn) was not run.",
      );
      const pretty = await tsverify(["test", "--strict"], { cwd });
      expect(pretty.stdout).toContain("--strict: 2 not-generated findings reported as errors.");
      expect(pretty.stdout).toMatch(/✗ 1 spec, 0 generated tests, 2 errors, 0 warnings\n$/);
    });

    it("leaves a spec without linked transitions alone", async () => {
      const spec = SPEC.replace("    impl: src/light.ts#switchOn\n", "");
      const cwd = await tempSpecDir({ ...PROJECT, "src/light.behavior.yaml": spec });
      const r = await tsverify(["test", "--strict", "--format", "json"], { cwd });
      expect(r.code).toBe(0);
    });
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
    expect(r.stdout).toContain("src/light.behavior.yaml  project: . · no tests generated");
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

  it("exits 2 before generating anything when the project's vitest is unusable", async () => {
    const cwd = await tempSpecDir({
      ...PROJECT,
      "node_modules/vitest/package.json": `{ "name": "vitest", "version": "2.1.9" }\n`,
    });
    const r = await tsverify(["test", "--format", "json"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      `tsverify test needs vitest ^3.0.5 || ^4.0.1 || ^5.0.0, but the vitest it found is 2.1.9 (${join(cwd, "node_modules/vitest/package.json")}): npm i -D vitest@5\n`,
    );
    await expect(readdir(join(cwd, ".tsverify"))).rejects.toThrow(/ENOENT/);
  });

  it("rejects a bad --format with exit 2", async () => {
    const r = await tsverify(["test", "--format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--format must be one of pretty, json");
  });
});

describe("strictUntested (tsverify test --strict)", () => {
  const spec = orderModel();
  const B = spec.name;
  const info = (subject: string, transition?: string) => ({
    id: `not-generated:${B}:testgen:${subject}`,
    category: "not-generated" as const,
    severity: "info" as const,
    message: subject,
    behavior: B,
    ...(transition ? { transition } : {}),
  });
  const pathTest = (transition: string) => ({
    file: "paths.test.ts",
    name: transition,
    kind: "path" as const,
    transition,
  });

  it("raises a transition's own not-generated finding; partial gaps stay info", () => {
    const tested = spec.transitions.filter((t) => t.name !== "refund").map((t) => t.name);
    const result = strictUntested(spec, {
      files: [],
      tests: tested.map(pathTest),
      skipped: [info("refund", "refund"), info("guards:ship:customer", "ship")],
    });
    expect(result.map((f) => [f.id, f.severity])).toEqual([
      [`not-generated:${B}:testgen:refund`, "error"],
      [`not-generated:${B}:testgen:guards:ship:customer`, "info"],
    ]);
  });

  it("adds an error for an untested transition with no finding of its own", () => {
    const tested = spec.transitions.filter((t) => t.name !== "ship").map((t) => t.name);
    const result = strictUntested(spec, { files: [], tests: tested.map(pathTest), skipped: [] });
    expect(result.map((f) => [f.id, f.severity, f.transition])).toEqual([
      [`not-generated:${B}:strict:ship`, "error", "ship"],
    ]);
  });

  it("reports a spec that got no test at all, even when every transition says why", () => {
    const skipped = spec.transitions.map((t) => info(t.name, t.name));
    const result = strictUntested(spec, { files: [], tests: [], skipped });
    expect(result.filter((f) => f.severity === "error").map((f) => f.id)).toEqual([
      ...skipped.map((f) => f.id),
      `not-generated:${B}:strict`,
    ]);
    expect(result.at(-1)?.message).toBe(
      `tsverify test generated no tests for ${B}, although 5 transitions have an \`impl\`: none of its code was run.`,
    );
  });
});
