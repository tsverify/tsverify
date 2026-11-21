import { describe, expect, it } from "vitest";
import { SPEC_ONLY_NOTE } from "../src/commands/check";
import { CANONICAL_DIR, tsv } from "./run";
import { b6VariantText, invalidSpecText, tempSpecDir } from "./temp-specs";

describe("check", () => {
  it("passes the canonical spec with a summary line", async () => {
    const r = await tsv(["check", CANONICAL_DIR]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(
      `${SPEC_ONLY_NOTE}\n✓ 1 spec, 0 errors, 0 warnings (6 states explored)\n`,
    );
  });

  it("accepts --spec-only without swallowing the next path", async () => {
    const r = await tsv(["check", "--spec-only", CANONICAL_DIR]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ 1 spec,");
  });

  it("fails the B6 variant (non-atomic refund) with exit 1 and a trace", async () => {
    const cwd = await tempSpecDir({ "order.behavior.yaml": await b6VariantText() });
    const r = await tsv(["check"], { cwd });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("✗ spec-property  order.behavior.yaml:58:9");
    expect(r.stdout).toContain("Exactly-once effect `stripe.refund` fires 2 times for one Order.");
    expect(r.stdout).toContain("trace:");
    expect(r.stdout).toContain(
      "refund#2 write  status=refunded  stripe.refund=2  ✗ effect-multiplicity",
    );
    expect(r.stdout).toMatch(/✗ 1 spec, 2 errors, 0 warnings \(\d+ states explored\)\n$/);
  });

  it("gives invalid input (2) precedence over violations (1)", async () => {
    const cwd = await tempSpecDir({
      "a/order.behavior.yaml": await b6VariantText(),
      "b/typo.behavior.yaml": await invalidSpecText(),
    });
    const r = await tsv(["check"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("✗ invalid-spec  b/typo.behavior.yaml:18:9");
    expect(r.stdout).toContain("✗ spec-property  a/order.behavior.yaml:58:9");
    expect(r.stdout).toContain("✗ 2 specs, 3 errors, 0 warnings");
  });

  it("reports a hit state limit as a warning, which never fails the run", async () => {
    const r = await tsv(["check", "--max-states", "2", CANONICAL_DIR]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("⚠ unanalyzable");
    expect(r.stdout).toContain("✓ 1 spec, 0 errors, 1 warning (2 states explored)");
  });

  it.each([["0"], ["-3"], ["many"], ["1.5"]])("rejects --max-states=%s", async (value) => {
    const r = await tsv(["check", `--max-states=${value}`, CANONICAL_DIR]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--max-states must be a positive integer");
    expect(r.stderr).toContain("$ tsv check [...paths] [options]");
  });
});
