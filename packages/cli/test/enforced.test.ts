import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonReport } from "../src/output/json";
import { CANONICAL_SPEC, REPO_ROOT, tsverify } from "./run";
import { invalidSpecText, tempSpecDir } from "./temp-specs";

const canonical = await readFile(join(REPO_ROOT, CANONICAL_SPEC), "utf8");
const enforced = canonical.replace("behavior: Order lifecycle\n", "$&enforced: true\n");
const renamed = (text: string, name: string) =>
  text.replace("behavior: Order lifecycle\n", `behavior: ${name}\n`);

function parse(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

describe("enforced specs", () => {
  it("json: specs[].enforced is present only for enforced specs", async () => {
    const cwd = await tempSpecDir({
      "a.behavior.yaml": enforced,
      "b.behavior.yaml": renamed(canonical, "Other"),
    });
    const r = await tsverify(["check", "--spec-only", "--format", "json"], { cwd });
    expect(r.code).toBe(0);
    expect(parse(r.stdout).specs.map((s) => [s.file, s.enforced])).toEqual([
      ["a.behavior.yaml", true],
      ["b.behavior.yaml", undefined],
    ]);
    const pretty = await tsverify(["check", "--spec-only"], { cwd });
    expect(pretty.stdout).toContain("a.behavior.yaml  spec only · enforced\n");
    expect(pretty.stdout).toContain("b.behavior.yaml  spec only\n");
  });

  it("--enforced-only keeps only enforced specs and says how many it skipped", async () => {
    const cwd = await tempSpecDir({
      "a.behavior.yaml": enforced,
      "b.behavior.yaml": renamed(canonical, "Other"),
    });
    const json = await tsverify(["check", "--spec-only", "--enforced-only", "--format", "json"], {
      cwd,
    });
    expect(json.code).toBe(0);
    expect(parse(json.stdout).specs.map((s) => s.file)).toEqual(["a.behavior.yaml"]);
    const pretty = await tsverify(["check", "--spec-only", "--enforced-only"], { cwd });
    expect(pretty.stdout).toContain(
      "--enforced-only: skipped 1 spec without `enforced: true`.\n✓ 1 spec,",
    );
  });

  it("--enforced-only with no enforced spec is an empty run that exits 0 and says why", async () => {
    const cwd = await tempSpecDir({ "a.behavior.yaml": canonical });
    const pretty = await tsverify(["check", "--spec-only", "--enforced-only"], { cwd });
    expect(pretty.code).toBe(0);
    expect(pretty.stdout).toBe(
      "No enforced specs: --enforced-only keeps only specs with `enforced: true`, and none of the 1 spec found has it.\n✓ 0 specs, 0 errors, 0 warnings\n",
    );
    const json = await tsverify(["check", "--spec-only", "--enforced-only", "--format", "json"], {
      cwd,
    });
    expect(json.code).toBe(0);
    expect(parse(json.stdout)).toEqual({
      version: 1,
      findings: [],
      specs: [],
      summary: { errors: 0, warnings: 0 },
    });
  });

  it("--enforced-only keeps invalid specs: they may be enforced", async () => {
    const cwd = await tempSpecDir({
      "a.behavior.yaml": canonical,
      "bad.behavior.yaml": await invalidSpecText(),
    });
    const r = await tsverify(["check", "--spec-only", "--enforced-only", "--format", "json"], {
      cwd,
    });
    expect(r.code).toBe(2);
    expect(parse(r.stdout).specs.map((s) => s.file)).toEqual(["bad.behavior.yaml"]);
  });

  it("test --enforced-only with no enforced spec generates and runs nothing", async () => {
    const cwd = await tempSpecDir({ "a.behavior.yaml": canonical });
    const r = await tsverify(["test", "--enforced-only"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No enforced specs: --enforced-only keeps only specs");
  });
});
