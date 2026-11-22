import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCode } from "../src/code-conformance";
import { loadSpecs } from "../src/inputs";
import type { JsonReport } from "../src/output/json";
import { CANONICAL_SPEC, REPO_ROOT, tsverify } from "./run";
import { tempSpecDir } from "./temp-specs";

// Code conformance in `tsverify check` on a tiny project; the orders app is covered by e2e/.

/** `switch_on` is linked to code; `smash` has no impl (an info finding). */
const LIGHT_SPEC = `behavior: Light
entity:
  name: Light
  state: status
  states: [off, on, broken]
  initial: off
  terminal: [on, broken]
actors:
  user: { trust: authenticated }
transitions:
  switch_on:
    from: off
    to: on
    by: user
    impl: src/light.ts#switchOn
  smash:
    from: off
    to: broken
    by: user
`;

const LIGHT_CODE = `export interface Light {
  id: string;
  status: "off" | "on" | "broken";
}

export function switchOn(light: Light): void {
  if (light.status !== "off") throw new Error("not off");
  light.status = "on";
}
`;

/** `switchOn` writes `on` from any state. */
const UNGUARDED_CODE = LIGHT_CODE.replace(
  `  if (light.status !== "off") throw new Error("not off");\n`,
  "",
);

const TSCONFIG = `{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n`;

function lightProject(prefix = "", code = LIGHT_CODE): Record<string, string> {
  return {
    [`${prefix}tsconfig.json`]: TSCONFIG,
    [`${prefix}src/light.ts`]: code,
    [`${prefix}src/light.behavior.yaml`]: LIGHT_SPEC,
  };
}

function parse(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

describe("check: code conformance", () => {
  it("extracts, compares and model-checks the code of the spec's project", async () => {
    const cwd = await tempSpecDir(lightProject());
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const doc = parse(r.stdout);
    expect(doc.specs).toEqual([
      {
        file: "src/light.behavior.yaml",
        behavior: "Light",
        stats: expect.objectContaining({ complete: true }),
        project: ".",
        codeStats: expect.objectContaining({ complete: true }),
        extract: { files: 1, writes: 1, probes: 1 },
      },
    ]);
  });

  it("shows info findings in pretty output without failing the run", async () => {
    const cwd = await tempSpecDir(lightProject());
    const r = await tsverify(["check"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^src\/light\.behavior\.yaml {2}project: \.\nLight\n/);
    expect(r.stdout).toContain("ℹ unanalyzable  src/light.behavior.yaml:16:3");
    expect(r.stdout).toContain("smash: not linked to code (no impl)");
    expect(r.stdout).toMatch(
      /✓ 1 spec, 0 errors, 0 warnings \(\d+ spec states, \d+ code states\)\n$/,
    );
  });

  it("assumes transitions without impl behave as specified", async () => {
    // The only way out of `on` has no impl. If the code model dropped it, the code-model checker
    // would report `on` as stuck: a false implementation-property error.
    const spec = LIGHT_SPEC.replace("terminal: [on, broken]", "terminal: [broken]").replace(
      "  smash:\n    from: off",
      "  smash:\n    from: on",
    );
    const cwd = await tempSpecDir({ ...lightProject(), "src/light.behavior.yaml": spec });
    const r = await tsverify(["check"], { cwd });
    expect(r.stdout).not.toContain("implementation-property");
    expect(r.code).toBe(0);
  });

  it("reports a write to a state the spec doesn't declare (no internal error)", async () => {
    // As-is specs for existing code often leave out a state; the code model must still be
    // checkable (it used to throw "unknown state" and exit 3).
    const spec = LIGHT_SPEC.replace("states: [off, on, broken]", "states: [off, on]")
      .replace("terminal: [on, broken]", "terminal: [on]")
      .replace(/ {2}smash:[\s\S]*$/, "");
    const code = `${LIGHT_CODE}\nexport function smash(light: Light): void {\n  light.status = "broken";\n}\n`;
    const cwd = await tempSpecDir({
      ...lightProject("", code),
      "src/light.behavior.yaml": spec,
    });
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(1);
    const undeclared = parse(r.stdout).findings.find((f) => f.category === "undeclared-transition");
    expect(undeclared?.message).toContain("'broken' is not a state of Light");
  });

  it("fails conformance mismatches with exit 1 and cwd-relative code locations", async () => {
    const cwd = await tempSpecDir(lightProject("app/", UNGUARDED_CODE));
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(1);
    const doc = parse(r.stdout);
    expect(doc.specs[0]?.project).toBe("app");
    const unconstrained = doc.findings.find((f) => f.category === "from-state-unconstrained");
    expect(unconstrained).toMatchObject({
      transition: "switch_on",
      // The first `from` item.
      specAt: { file: "app/src/light.behavior.yaml", line: 12, column: 11 },
      codeAt: { file: "app/src/light.ts", line: 7, column: 3 },
    });
  });

  it("reports a string-typed state field once, as the extractor's unanalyzable", async () => {
    const code = UNGUARDED_CODE.replace('status: "off" | "on" | "broken";', "status: string;");
    const cwd = await tempSpecDir(lightProject("", code));
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(0);
    const findings = parse(r.stdout).findings.filter((f) => f.transition === "switch_on");
    expect(findings.map((f) => [f.id, f.severity])).toEqual([
      ["unanalyzable:Light:from-state:switch_on", "warning"],
    ]);
  });

  it("uses the nearest tsconfig.json", async () => {
    // src/tsconfig.json makes src/ the project root, so `impl: src/light.ts` no longer resolves.
    const cwd = await tempSpecDir({ ...lightProject(), "src/tsconfig.json": TSCONFIG });
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(2);
    const doc = parse(r.stdout);
    expect(doc.specs[0]?.project).toBe("src");
    expect(doc.findings).toContainEqual(
      expect.objectContaining({ id: "broken-link:Light:impl:switch_on" }),
    );
  });

  it("--project overrides discovery, resolved against the cwd", async () => {
    // Same layout as above: discovery would pick src/, which breaks the impl link.
    const cwd = await tempSpecDir({ ...lightProject(), "src/tsconfig.json": TSCONFIG });
    const r = await tsverify(["check", "--project", ".", "--format", "json"], { cwd });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(parse(r.stdout).specs[0]).toMatchObject({
      file: "src/light.behavior.yaml",
      project: ".",
    });

    const inner = await tsverify(["check", "--project", "..", "--format", "json"], {
      cwd: join(cwd, "src"),
    });
    expect(inner.code).toBe(0);
    const doc = parse(inner.stdout);
    expect(doc.specs[0]).toMatchObject({ file: "light.behavior.yaml", project: ".." });
    // Locations are relative to the cwd too (code locations: see the conformance-mismatch test).
    expect(doc.findings.map((f) => f.specAt?.file ?? f.codeAt?.file)).toEqual([
      "light.behavior.yaml",
    ]);
  });

  it("--project lets a spec live outside its project", async () => {
    const cwd = await tempSpecDir({
      "app/tsconfig.json": TSCONFIG,
      "app/src/light.ts": UNGUARDED_CODE,
      "specs/light.behavior.yaml": LIGHT_SPEC,
    });
    const r = await tsverify(["check", "specs", "--project", "app", "--format", "json"], { cwd });
    expect(r.code).toBe(1);
    const doc = parse(r.stdout);
    expect(doc.specs[0]).toMatchObject({ file: "specs/light.behavior.yaml", project: "app" });
    expect(doc.findings.find((f) => f.category === "from-state-unconstrained")).toMatchObject({
      specAt: { file: "specs/light.behavior.yaml" },
      codeAt: { file: "app/src/light.ts" },
    });
  });

  it("rejects a --project directory that doesn't exist (exit 2)", async () => {
    const cwd = await tempSpecDir(lightProject());
    const r = await tsverify(["check", "--project", "nope"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error: --project: no such directory: nope");
    expect(r.stderr).toContain("$ tsverify check [...paths] [options]");
  });

  it("reports a spec with no tsconfig.json up the tree as a broken link (exit 2)", async () => {
    // Assumes nothing above the temp directory holds a tsconfig.json.
    const spec = await readFile(join(REPO_ROOT, CANONICAL_SPEC), "utf8");
    const cwd = await tempSpecDir({ "order.behavior.yaml": spec });
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(2);
    const doc = parse(r.stdout);
    expect(doc.specs[0]).toMatchObject({ project: null });
    expect(doc.specs[0]?.codeStats).toBeUndefined();
    expect(doc.findings).toEqual([
      {
        id: "broken-link:Order lifecycle:tsconfig",
        category: "broken-link",
        severity: "error",
        message:
          "no tsconfig.json in the current directory or any directory above it, so the code behind `impl` and `bindings` can't be located",
        behavior: "Order lifecycle",
        specAt: { file: "order.behavior.yaml", line: 1, column: 1 },
        hint: "Pass --project <dir> to name the TypeScript project root, or --spec-only to check the spec alone.",
      },
    ]);

    const pretty = await tsverify(["check"], { cwd });
    expect(pretty.stdout).toMatch(/^order\.behavior\.yaml {2}no project\n/);

    const specOnly = await tsverify(["check", "--spec-only"], { cwd });
    expect(specOnly.code).toBe(0);
    expect(specOnly.stdout).toContain("✓ 1 spec, 0 errors, 0 warnings (6 spec states)");
  });

  it("skips code conformance for invalid specs", async () => {
    const cwd = await tempSpecDir({
      ...lightProject(),
      "src/bad.behavior.yaml": LIGHT_SPEC.replace("to: on", "to: onn"),
    });
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(2);
    const doc = parse(r.stdout);
    const bad = doc.specs.find((s) => s.file === "src/bad.behavior.yaml");
    expect(bad).toEqual({ file: "src/bad.behavior.yaml", behavior: "Light", project: "." });
    expect(doc.findings.map((f) => f.category)).toEqual(["invalid-spec", "unanalyzable"]);
  });

  it("extracts each project once and shares its stats", async () => {
    const cwd = await tempSpecDir({
      ...lightProject(),
      "src/copy.behavior.yaml": LIGHT_SPEC.replace("behavior: Light", "behavior: Light copy"),
    });
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(0);
    const doc = parse(r.stdout);
    expect(doc.specs.map((s) => [s.behavior, s.project, s.extract])).toEqual([
      ["Light copy", ".", { files: 1, writes: 1, probes: 1 }],
      ["Light", ".", { files: 1, writes: 1, probes: 1 }],
    ]);
  });

  it("returns the models it compared, relative to the project root (for tsverify test)", async () => {
    const cwd = await tempSpecDir(lightProject("app/"));
    const specs = await loadSpecs(["app/src/light.behavior.yaml"], cwd);
    const [outcome] = await checkCode(specs, { cwd });
    expect(outcome?.root).toBe(join(cwd, "app"));
    expect(outcome?.spec?.transitions.find((t) => t.name === "switch_on")?.at?.file).toBe(
      "src/light.behavior.yaml",
    );
    expect(outcome?.code?.origin).toBe("code");
    expect(outcome?.code?.transitions.find((t) => t.name === "switch_on")?.sites?.write.file).toBe(
      "src/light.ts",
    );
    // Findings stay relative to the cwd.
    expect(outcome?.findings.map((f) => f.specAt?.file)).toContain("app/src/light.behavior.yaml");
  });
});
