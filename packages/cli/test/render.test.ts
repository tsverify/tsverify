import { join } from "node:path";
import type { BehaviorModel } from "@tsverify/ir";
import { permissionMatrixMarkdown, summarize, toMermaid } from "@tsverify/render";
import { loadSpec } from "@tsverify/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { CANONICAL_SPEC, INVALID_SPEC, REPO_ROOT, tsverify } from "./run";

let model: BehaviorModel;
beforeAll(async () => {
  const result = await loadSpec(join(REPO_ROOT, CANONICAL_SPEC), { root: REPO_ROOT });
  if (!result.model) throw new Error("canonical spec is invalid");
  model = result.model;
});

describe("render", () => {
  it.each([
    ["--mermaid", () => toMermaid(model)],
    ["--matrix", () => permissionMatrixMarkdown(model)],
    ["--summary", () => summarize(model)],
  ])("%s prints exactly what @tsverify/render produces", async (flag, expected) => {
    const r = await tsverify(["render", CANONICAL_SPEC, flag]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(expected());
  });

  it("defaults to --mermaid", async () => {
    const r = await tsverify(["render", CANONICAL_SPEC]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(toMermaid(model));
  });

  it("puts findings for an invalid spec on stderr and exits 2", async () => {
    const r = await tsverify(["render", INVALID_SPEC]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(`${INVALID_SPEC}:18:9`);
  });

  it("rejects more than one view flag", async () => {
    const r = await tsverify(["render", CANONICAL_SPEC, "--matrix", "--summary"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("choose one of --matrix, --summary");
  });

  it("requires a spec argument", async () => {
    const r = await tsverify(["render"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing required args");
  });
});
