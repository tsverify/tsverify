import { describe, expect, it } from "vitest";
import { CANONICAL_DIR, tsverify } from "./run";
import { b6VariantText, invalidSpecText, tempSpecDir } from "./temp-specs";

// Spec-level behavior only: code conformance is covered by check-code.test.ts and e2e/.
describe("check --spec-only", () => {
  it("passes the canonical spec with a summary line", async () => {
    const r = await tsverify(["check", "--spec-only", CANONICAL_DIR]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      [
        `${CANONICAL_DIR}/order.behavior.yaml  spec only`,
        "✓ no findings",
        "",
        "✓ 1 spec, 0 errors, 0 warnings (6 spec states)",
        "",
      ].join("\n"),
    );
  });

  it("does not swallow the next path", async () => {
    const r = await tsverify(["check", CANONICAL_DIR, "--spec-only"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 1 spec,");
  });

  it("fails the B6 variant (non-atomic refund) with exit 1 and a trace", async () => {
    const cwd = await tempSpecDir({ "order.behavior.yaml": await b6VariantText() });
    const r = await tsverify(["check", "--spec-only"], { cwd });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ spec-property  order.behavior.yaml:58:9");
    expect(r.stdout).toContain("Exactly-once effect `stripe.refund` fires 2 times for one Order.");
    expect(r.stdout).toContain("trace:");
    expect(r.stdout).toContain(
      "refund#2 write  status=refunded  stripe.refund=2  ✗ effect-multiplicity",
    );
    expect(r.stdout).toMatch(/✗ 1 spec, 2 errors, 0 warnings \(\d+ spec states\)\n$/);
  });

  it("gives invalid input (2) precedence over violations (1)", async () => {
    const cwd = await tempSpecDir({
      "a/order.behavior.yaml": await b6VariantText(),
      "b/typo.behavior.yaml": await invalidSpecText(),
    });
    const r = await tsverify(["check", "--spec-only"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("✗ invalid-spec  b/typo.behavior.yaml:18:9");
    expect(r.stdout).toContain("✗ spec-property  a/order.behavior.yaml:58:9");
    expect(r.stdout).toContain("✗ 2 specs, 3 errors, 0 warnings");
  });

  it("reports a hit state limit as a warning, which never fails the run", async () => {
    const r = await tsverify(["check", "--spec-only", "--max-states", "2", CANONICAL_DIR]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("⚠ unanalyzable");
    expect(r.stdout).toContain("✓ 1 spec, 0 errors, 1 warning (2 spec states)");
  });

  it.each([["0"], ["-3"], ["many"], ["1.5"]])("rejects --max-states=%s", async (value) => {
    const r = await tsverify(["check", "--spec-only", `--max-states=${value}`, CANONICAL_DIR]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--max-states must be a positive integer");
    expect(r.stderr).toContain("$ tsverify check [...paths] [options]");
  });
});
