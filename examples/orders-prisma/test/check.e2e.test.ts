/**
 * End-to-end: `tsv check` on the Prisma app, clean and with every seeded-bug variant. B1–B6 must
 * give exactly the findings (ids and severities) the assign app's `tsv check` gives for the same
 * bug (its goldens in packages/cli/test/e2e/__golden__); B7 is Prisma-specific. Every variant
 * also meets its `variant.json`.
 */
import { describe, expect, it } from "vitest";
import { listVariants, matchesExpected, readManifest } from "./materialize";
import { assignCheckFindings, tsvCheck } from "./tsv";

const VARIANTS = await listVariants();
const SHARED = VARIANTS.filter((v) => v !== "b7-tx-read-committed");

describe("tsv check on examples/orders-prisma", { timeout: 60_000 }, () => {
  it("passes the clean app with no findings, like the assign app", async () => {
    const run = await tsvCheck(undefined);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.report.findings).toEqual([]);
    expect(await assignCheckFindings("clean")).toEqual([]);
    expect(run.report.specs).toEqual([
      expect.objectContaining({ file: "src/orders/order.behavior.yaml", project: "." }),
    ]);
  });

  it.each(VARIANTS)("fails %s with its expected findings", async (variant) => {
    const manifest = await readManifest(variant);
    const run = await tsvCheck(variant);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(1);
    for (const expected of manifest.expected) {
      expect(
        run.report.findings.some((f) => matchesExpected(f, expected)),
        `no finding matches ${JSON.stringify(expected)}`,
      ).toBe(true);
    }
  });

  it.each(SHARED)("%s: the same findings as the assign app", async (variant) => {
    const run = await tsvCheck(variant);
    expect(run.report.findings.map((f) => `${f.severity} ${f.id}`)).toEqual(
      await assignCheckFindings(variant),
    );
  });

  it("b7: a default-isolation $transaction is a race, with the isolation note", async () => {
    const run = await tsvCheck("b7-tx-read-committed");
    expect(run.report.findings.map((f) => `${f.severity} ${f.id}`)).toEqual([
      "info non-atomic:Order lifecycle:refund:isolation-level",
      "error non-atomic:Order lifecycle:refund",
      "error implementation-property:Order lifecycle:rule:Refund issued at most once per order",
      "error implementation-property:Order lifecycle:effect-multiplicity:stripe.refund",
    ]);
    const note = run.report.findings[0];
    expect(note).toMatchObject({
      transition: "refund",
      codeAt: { file: "src/orders/refund.ts", line: 14 },
    });
    expect(note?.message).toContain(
      "refund: the interactive prisma.$transaction runs at the database's default isolation level (READ COMMITTED on PostgreSQL)",
    );
    expect(note?.hint).toContain("order.updateMany({ where: { id, status: <from-state> }");
    expect(note?.hint).toContain("Prisma.TransactionIsolationLevel.Serializable");
    const effect = run.report.findings.find(
      (f) => f.id === "implementation-property:Order lifecycle:effect-multiplicity:stripe.refund",
    );
    expect(effect?.causedBy).toContain("non-atomic:Order lifecycle:refund");
  });
});
