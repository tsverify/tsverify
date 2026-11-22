import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_DIR, CANONICAL_SPEC, INVALID_SPEC, REPO_ROOT, tsverify } from "./run";

describe("validate", () => {
  it("accepts the canonical spec directory", async () => {
    const r = await tsverify(["validate", CANONICAL_DIR]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("✓ 1 spec, 0 errors, 0 warnings\n");
    expect(r.stderr).toBe("");
  });

  it("searches the cwd by default", async () => {
    const r = await tsverify(["validate"], { cwd: join(REPO_ROOT, CANONICAL_DIR) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 1 spec");
  });

  it("rejects an invalid spec with exit 2 and a cwd-relative location", async () => {
    const r = await tsverify(["validate", INVALID_SPEC]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`✗ invalid-spec  ${INVALID_SPEC}:18:9`);
    expect(r.stdout).toContain('unknown state "shiped"');
    expect(r.stdout).toContain("✗ 1 spec, 1 error, 0 warnings\n");
  });

  it("reports locations relative to the cwd", async () => {
    const r = await tsverify(["validate", "typo.behavior.yaml"], {
      cwd: join(REPO_ROOT, "packages/cli/test/fixtures/invalid"),
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("✗ invalid-spec  typo.behavior.yaml:18:9");
  });

  it("validates files and directories together, each file once", async () => {
    const r = await tsverify([
      "validate",
      INVALID_SPEC,
      CANONICAL_SPEC,
      "packages/cli/test/fixtures",
    ]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("✗ 2 specs, 1 error, 0 warnings");
  });

  it("reports a missing file as invalid input", async () => {
    const r = await tsverify(["validate", "missing.behavior.yaml"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("missing.behavior.yaml:1:1");
    expect(r.stdout).toContain("ENOENT");
  });

  it("treats a directory without specs as bad usage", async () => {
    const r = await tsverify(["validate", "packages/ir"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no *.behavior.yaml files found in packages/ir");
  });
});

describe("colors", () => {
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`);

  it("are on for a TTY with NO_COLOR unset", async () => {
    const r = await tsverify(["validate", INVALID_SPEC], { isTTY: true, env: {} });
    expect(r.stdout).toMatch(ANSI);
  });

  it("are off when NO_COLOR is set", async () => {
    const r = await tsverify(["validate", INVALID_SPEC], { isTTY: true, env: { NO_COLOR: "1" } });
    expect(r.stdout).not.toMatch(ANSI);
  });

  it("are off when stdout is not a TTY", async () => {
    const r = await tsverify(["validate", INVALID_SPEC], { isTTY: false, env: {} });
    expect(r.stdout).not.toMatch(ANSI);
  });

  it("follow FORCE_COLOR over the TTY check", async () => {
    const on = await tsverify(["validate", INVALID_SPEC], {
      isTTY: false,
      env: { FORCE_COLOR: "1" },
    });
    expect(on.stdout).toMatch(ANSI);
    const off = await tsverify(["validate", INVALID_SPEC], {
      isTTY: true,
      env: { FORCE_COLOR: "0" },
    });
    expect(off.stdout).not.toMatch(ANSI);
  });
});
