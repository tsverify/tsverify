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

  describe("--strict", () => {
    const stringTyped = () =>
      tempSpecDir(
        lightProject(
          "",
          UNGUARDED_CODE.replace('status: "off" | "on" | "broken";', "status: string;"),
        ),
      );

    it("reports unanalyzable warnings as errors and exits 1 (json)", async () => {
      const cwd = await stringTyped();
      const r = await tsverify(["check", "--strict", "--format", "json"], { cwd });
      expect(r.code).toBe(1);
      const doc = parse(r.stdout);
      expect(doc.strict).toBe(true);
      expect(doc.summary).toEqual({ errors: 1, warnings: 0 });
      expect(doc.findings.map((f) => [f.id, f.severity])).toEqual([
        ["unanalyzable:Light:from-state:switch_on", "error"],
        // A transition without impl is the spec's choice: it stays an info.
        ["unanalyzable:Light:smash", "info"],
      ]);
    });

    it("marks the raised results in SARIF and says so in pretty output", async () => {
      const cwd = await stringTyped();
      const sarif = await tsverify(["check", "--strict", "--format", "sarif"], { cwd });
      expect(sarif.code).toBe(1);
      const results = (
        JSON.parse(sarif.stdout) as {
          runs: [{ results: { ruleId: string; level: string; properties: object }[] }];
        }
      ).runs[0].results;
      expect(results.map((x) => [x.ruleId, x.level, x.properties])).toEqual([
        ["unanalyzable", "error", { behavior: "Light", transition: "switch_on", strict: true }],
        ["unanalyzable", "note", { behavior: "Light", transition: "smash" }],
      ]);
      const pretty = await tsverify(["check", "--strict"], { cwd });
      expect(pretty.code).toBe(1);
      expect(pretty.stdout).toContain("✗ unanalyzable");
      expect(pretty.stdout).toContain("--strict: 1 unanalyzable finding reported as an error.");
      expect(pretty.stdout).toMatch(/✗ 1 spec, 1 error, 0 warnings/);
    });

    it("changes nothing on code it can analyze", async () => {
      const cwd = await tempSpecDir(lightProject());
      const r = await tsverify(["check", "--strict"], { cwd });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("--strict");
    });

    it("makes tsverify test report the static unanalyzable warnings, as errors", async () => {
      const cwd = await stringTyped();
      const plain = await tsverify(["test", "--format", "json"], { cwd });
      expect(plain.code).toBe(0);
      expect(parse(plain.stdout).findings.map((f) => f.category)).not.toContain("unanalyzable");
      const r = await tsverify(["test", "--strict", "--format", "json"], { cwd });
      expect(r.code).toBe(1);
      const doc = parse(r.stdout);
      expect(doc.strict).toBe(true);
      expect(
        doc.findings.filter((f) => f.severity !== "info").map((f) => [f.id, f.severity]),
      ).toEqual([
        ["unanalyzable:Light:from-state:switch_on", "error"],
        // No test was generated (no fixtures): under --strict, that is an error too.
        ["not-generated:Light:testgen:fixtures", "error"],
        ["not-generated:Light:strict:switch_on", "error"],
      ]);
    });
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

  it("prints paths outside the cwd absolute in pretty output, relative in JSON", async () => {
    const dir = await tempSpecDir({ ...lightProject("app/", UNGUARDED_CODE), "work/.keep": "" });
    const cwd = join(dir, "work");
    const pretty = await tsverify(["check", "../app"], { cwd });
    expect(pretty.code).toBe(1);
    expect(pretty.stdout).toContain(
      `${join(dir, "app/src/light.behavior.yaml")}  project: ${join(dir, "app")}\n`,
    );
    expect(pretty.stdout).toContain(`${join(dir, "app/src/light.ts")}:7:3`);
    expect(pretty.stdout).not.toContain("../");
    const json = parse((await tsverify(["check", "../app", "--format", "json"], { cwd })).stdout);
    expect(json.specs[0]).toMatchObject({
      file: "../app/src/light.behavior.yaml",
      project: "../app",
    });
    expect(json.findings.map((f) => f.codeAt?.file)).toContain("../app/src/light.ts");
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

describe("check: by lists alternative actors (owner or admin)", () => {
  const SPEC = `behavior: Order cancel
entity:
  name: Order
  state: status
  states: [paid, cancelled]
  initial: paid
  terminal: [cancelled]
actors:
  customer: { trust: authenticated, requires: owner }
  admin: { trust: authenticated, requires: role(admin) }
transitions:
  cancel:
    from: paid
    to: cancelled
    by: [customer, admin]
    impl: src/cancel.ts#cancelOrder
bindings:
  guards:
    owner: src/guards.ts#requireOwner
    role(admin): src/guards.ts#requireRole("admin")
`;
  const GUARDS = `export interface Actor {
  id: string;
  roles: string[];
}

export function requireOwner(actor: Actor, order: { ownerId: string }): void {
  if (order.ownerId !== actor.id) throw new Error("not the owner");
}

export function requireRole(actor: Actor, role: string): void {
  if (!actor.roles.includes(role)) throw new Error(\`not \${role}\`);
}
`;
  const cancel = (
    guards: string,
  ) => `import { type Actor, requireOwner, requireRole } from "./guards";

export interface Order {
  id: string;
  ownerId: string;
  status: "paid" | "cancelled";
}

export function cancelOrder(actor: Actor, order: Order): void {
  const isAdmin = actor.roles.includes("admin");
${guards}
  if (order.status !== "paid") throw new Error("not paid");
  order.status = "cancelled";
}
`;
  const project = (guards: string) =>
    tempSpecDir({
      "tsconfig.json": TSCONFIG,
      "src/order.behavior.yaml": SPEC,
      "src/guards.ts": GUARDS,
      "src/cancel.ts": cancel(guards),
    });

  it("accepts a path per actor: requireRole for admins, requireOwner otherwise", async () => {
    const cwd = await project(
      '  if (isAdmin) requireRole(actor, "admin");\n  else requireOwner(actor, order);',
    );
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(0);
    expect(parse(r.stdout).findings).toEqual([]);
  });

  it("names the admin alternative when the admin path skips requireRole", async () => {
    const cwd = await project("  void requireRole;\n  if (!isAdmin) requireOwner(actor, order);");
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(1);
    expect(parse(r.stdout).findings).toEqual([
      expect.objectContaining({
        id: "guard-not-dominating:Order cancel:cancel:path:{}",
        message:
          "cancel: cancelOrder reaches the write on a path that passes no guard; it must pass owner to act as customer, or role(admin) to act as admin.",
        hint: "Call requireOwner (as customer) or requireRole (as admin) on every path from cancelOrder to the write, before any early return.",
        // The requireOwner call that only some paths reach.
        codeAt: expect.objectContaining({ file: "src/cancel.ts", line: 12, column: 17 }),
      }),
    ]);
  });
});

describe("check: state writes tsverify can't read (named storage functions)", () => {
  // The OpenStatus shape: one generic verb, the target state from the input, in a patch object
  // held in a variable and passed to a query builder; plus a literal one passed straight to it.
  const REPO = `export type IncidentStatus = "open" | "mitigated" | "resolved";
export type Incident = { id: number; status: IncidentStatus };
type SQL = { sql: string };
export type Tx = {
  update(table: "incident"): {
    set(values: { status?: IncidentStatus | SQL }): Promise<Incident | undefined>;
  };
};
export async function getIncident(_tx: Tx, id: number): Promise<Incident> {
  return { id, status: "open" };
}
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return fn({} as Tx);
}
`;
  const VERBS = `import { getIncident, type IncidentStatus, withTransaction } from "./repo";
export async function setStatus(input: { id: number; status: IncidentStatus }) {
  return withTransaction(async (tx) => {
    const existing = await getIncident(tx, input.id);
    if (existing.status === input.status) throw new Error("same");
    const patch = { status: input.status };
    const updated = await tx.update("incident").set(patch);
    if (!updated) throw new Error("race");
    return updated;
  });
}
export function reply(json: (body: unknown) => void) {
  const body = { status: "ok" };
  json(body);
  json({ status: "ok" });
}
`;
  const SPEC = `behavior: Incidents
entity:
  name: Incident
  state: status
  states: [open, mitigated, resolved]
  initial: open
  terminal: [resolved]
actors:
  member: { trust: authenticated }
transitions:
  mitigate:
    from: open
    to: mitigated
    by: member
    atomic: true
    impl: src/verbs.ts#IMPL_MITIGATE
  resolve:
    from: [open, mitigated]
    to: resolved
    by: member
    atomic: true
    impl: src/verbs.ts#setStatus
bindings:
  storage:
    read: { fn: src/repo.ts#getIncident, args: [_, key] }
    atomic: { fn: src/repo.ts#withTransaction, args: [callback] }
`;
  const MITIGATE = `import { getIncident, withTransaction } from "./repo";
export async function mitigateInline(input: { id: number }) {
  return withTransaction(async (tx) => {
    const existing = await getIncident(tx, input.id);
    if (existing.status !== "open") throw new Error("not open");
    return tx.update("incident").set({ status: "mitigated" });
  });
}
`;
  const project = (mitigateImpl: string) =>
    tempSpecDir({
      "tsconfig.json": TSCONFIG,
      "src/repo.ts": REPO,
      "src/verbs.ts": VERBS,
      ...(mitigateImpl.startsWith("mitigate.ts") ? { "src/mitigate.ts": MITIGATE } : {}),
      "src/incident.behavior.yaml": SPEC.replace("verbs.ts#IMPL_MITIGATE", mitigateImpl),
    });

  it("reports a write it can't read, never `missing-transition`, and links the consequences", async () => {
    const cwd = await project("verbs.ts#setStatus");
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.stderr).toBe("");
    const findings = parse(r.stdout).findings;
    expect(findings.map((f) => f.category)).not.toContain("missing-transition");
    const write = findings.find((f) => f.id === "unanalyzable:Incidents:write-value:setStatus");
    expect(write).toMatchObject({
      severity: "warning",
      message:
        "Incident.status is assigned a value that is not a single literal (input.status); the write is not extracted",
      codeAt: { file: "src/verbs.ts", line: 6 },
    });
    const unconfirmed = findings.filter((f) => f.id.endsWith(":unconfirmed"));
    expect(unconfirmed.map((f) => [f.id, f.severity, f.causedBy])).toEqual([
      ["unanalyzable:Incidents:mitigate:unconfirmed", "warning", [write?.id]],
      ["unanalyzable:Incidents:resolve:unconfirmed", "warning", [write?.id]],
    ]);
    expect(unconfirmed[0]?.message).toBe(
      "mitigate: couldn't confirm that setStatus writes status = mitigated: it changes status at verbs.ts:6 in a form tsverify can't read (the value `input.status` is not a single literal).",
    );
    // Unconfirmed transitions are taken as specified in the code model, like ones without
    // `impl`: no stuck state or other artifact of what tsverify couldn't read. Only warnings.
    expect(findings.filter((f) => f.category === "implementation-property")).toEqual([]);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.code).toBe(0);

    const pretty = await tsverify(["check"], { cwd });
    expect(pretty.stdout).toContain(
      "    ↳ consequence: ⚠ unanalyzable  src/incident.behavior.yaml:11:3 · src/verbs.ts:6:21",
    );

    const strict = await tsverify(["check", "--strict"], { cwd });
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("--strict: 3 unanalyzable findings reported as errors.");
  });

  it("a transition whose impl writes nothing at all is still missing, with its consequences", async () => {
    // `reply` writes no Incident status: `mitigate` is missing, and with `resolve` only from
    // `mitigated` (unconfirmed, so taken as specified), nothing leaves `open` any more.
    const cwd = await tempSpecDir({
      "tsconfig.json": TSCONFIG,
      "src/repo.ts": REPO,
      "src/verbs.ts": VERBS,
      "src/incident.behavior.yaml": SPEC.replace(
        "verbs.ts#IMPL_MITIGATE",
        "verbs.ts#reply",
      ).replace("from: [open, mitigated]", "from: mitigated"),
    });
    const r = await tsverify(["check", "--format", "json"], { cwd });
    expect(r.code).toBe(1);
    const findings = parse(r.stdout).findings;
    const missing = findings.find((f) => f.id === "missing-transition:Incidents:mitigate");
    expect(missing).toMatchObject({ severity: "error" });
    expect(findings.some((f) => f.id === "unanalyzable:Incidents:mitigate:unconfirmed")).toBe(
      false,
    );
    expect(
      findings.find((f) => f.id === "unanalyzable:Incidents:resolve:unconfirmed"),
    ).toBeDefined();
    const stuck = findings.find((f) => f.property === "no-stuck-states");
    expect(stuck?.causedBy).toEqual([missing?.id]);
  });

  it("an unbound write gets only its unanalyzable finding, no non-atomic", async () => {
    const cwd = await project("mitigate.ts#mitigateInline");
    const r = await tsverify(["check", "--format", "json"], { cwd });
    const ids = parse(r.stdout).findings.map((f) => f.id);
    expect(ids.filter((id) => id.includes(":mitigate"))).toEqual([
      "unanalyzable:Incidents:storage:mitigate",
    ]);
    // `reply`'s `{ status: "ok" }` objects are not the entity's.
    expect(ids.some((id) => id.includes("reply"))).toBe(false);
  });
});
